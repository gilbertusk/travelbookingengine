import { err, ok, type Result } from '@tbe/shared-kernel'
import { calendarDateFromOrbit, toOrbitDate } from '../canonical/dates.js'
import { money, type Money } from '../canonical/money.js'
import { cancellationPolicy } from '../canonical/model.js'
import type {
  BookingResult,
  HoldResult,
  PriceCheckResult,
  RatePlan,
  RoomType,
  SupplierProperty,
  SupplierSearchResult,
} from '../canonical/model.js'
import type { SupplierError } from '../errors/supplier-error.js'
import type { HttpResponse, Operation, SupplierHttp } from '../http/client.js'
import { invalidResponse, mapHttpFailure } from '../http/failure.js'
import { attribute, child, list, parseXml, soapBody, text, yesNo } from '../http/xml.js'
import type { XmlNode } from '../http/xml.js'
import type { GuestDetails, SearchCriteria, SupplierGateway } from '../ports/supplier-gateway.js'

/**
 * ORBIT — SOAP XML, IDR, PascalCase, tanggal DD/MM/YYYY.
 *
 * Adapter ini adalah alasan lapisan ini ada. Tiga hal yang tidak muncul di
 * mana pun kecuali di sini:
 *
 * 1. Tanggal DD/MM/YYYY, yang dibaca terbalik oleh parser mana pun yang
 *    mengasumsikan urutan Amerika — dan kesalahannya tidak terlihat pada
 *    tanggal di bawah 13.
 * 2. Elemen tunggal yang tidak menjadi larik. Satu hotel dalam hasil datang
 *    sebagai objek, dua hotel sebagai larik.
 * 3. Kegagalan datang sebagai `<Fault>` di dalam amplop, bukan hanya sebagai
 *    status HTTP — dan sebagian fault datang bersama status 200.
 */

const SUPPLIER = 'ORBIT' as const

function fail(operation: Operation, reason: string): SupplierError {
  return invalidResponse(SUPPLIER, operation, reason)
}

/**
 * Amplop SOAP yang sudah diurai, atau kegagalan.
 *
 * Fault diperiksa lebih dulu daripada status: ORBIT mengirim sebagian fault
 * dengan status 200, dan membaca status saja akan membuat kegagalan itu
 * diteruskan sebagai hasil yang sah.
 */
function openEnvelope(
  operation: Operation,
  response: HttpResponse,
  expected: string,
): Result<XmlNode, SupplierError> {
  const document = parseXml(response.text)
  const body = document === undefined ? undefined : soapBody(document)

  if (body === undefined) {
    return response.status >= 200 && response.status < 300
      ? err(fail(operation, 'bukan amplop SOAP yang dapat diurai'))
      : err(mapHttpFailure({ supplier: SUPPLIER, operation, response }))
  }

  const fault = child(body, 'Fault')
  if (fault !== undefined) {
    const code = text(fault, 'Code')
    return err(
      mapHttpFailure({
        supplier: SUPPLIER,
        operation,
        // Fault dengan status 200 tetap harus menjadi kegagalan. Status 200
        // dipetakan menjadi upstream_error lewat jalur ini, bukan diabaikan.
        response,
        code,
      }),
    )
  }

  if (response.status < 200 || response.status >= 300) {
    return err(mapHttpFailure({ supplier: SUPPLIER, operation, response }))
  }

  const payload = child(body, expected)
  return payload === undefined ? err(fail(operation, `tidak ada <${expected}>`)) : ok(payload)
}

/** `<Amount Currency="IDR">2893400</Amount>` */
function amountOf(node: XmlNode, name: string, operation: Operation): Result<Money, SupplierError> {
  const raw = text(node, name)
  const currency = attribute(node, name, 'Currency')

  if (raw === undefined) return err(fail(operation, `tidak ada <${name}>`))
  if (currency !== 'IDR') return err(fail(operation, `mata uang <${name}> bukan IDR`))

  const amount = Number(raw)
  if (!Number.isSafeInteger(amount)) return err(fail(operation, `<${name}> bukan bilangan bulat`))

  return ok(money(amount, 'IDR'))
}

function intOf(value: string | undefined): number | undefined {
  if (value === undefined) return undefined

  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function envelope(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Envelope><Body>${inner}</Body></Envelope>`
}

function stayNodes(stay: {
  readonly checkIn: string
  readonly checkOut: string
}): string | undefined {
  const from = toOrbitDate(stay.checkIn)
  const to = toOrbitDate(stay.checkOut)
  if (from === undefined || to === undefined) return undefined

  return `<FromDate>${from}</FromDate><ToDate>${to}</ToDate>`
}

async function soapCall(
  http: SupplierHttp,
  operation: Operation,
  action: string,
  inner: string,
): Promise<Result<HttpResponse, SupplierError>> {
  return await http.send({
    operation,
    method: 'POST',
    path: '/soap',
    contentType: 'text/xml',
    headers: { SOAPAction: action },
    body: envelope(inner),
  })
}

export function createOrbitAdapter(http: SupplierHttp): SupplierGateway {
  return {
    supplier: SUPPLIER,
    search: async (criteria) => await search(http, criteria),
    priceCheck: async (rateCode, stay) => await priceCheck(http, rateCode, stay),
    hold: async (rateCode, stay, guests) => await hold(http, rateCode, stay, guests),
    book: async (holdCode, guest, key) => await book(http, holdCode, guest, key),
    cancel: async (reference) => await cancel(http, reference),
    getBooking: async (reference) =>
      await retrieve(http, `<BookingCode>${reference}</BookingCode>`),
    findBookingByIdempotencyKey: async (key) =>
      await retrieve(http, `<ClientReference>${key}</ClientReference>`),
  }
}

async function search(
  http: SupplierHttp,
  criteria: SearchCriteria,
): Promise<Result<SupplierSearchResult, SupplierError>> {
  const stay = stayNodes(criteria)
  if (stay === undefined) return err(fail('search', 'tanggal menginap tidak sah'))

  const sent = await soapCall(
    http,
    'search',
    'Availability',
    `<AvailabilityRequest><Location>${criteria.city}</Location>${stay}<PaxCount>${String(criteria.guests)}</PaxCount></AvailabilityRequest>`,
  )
  if (!sent.ok) return sent

  const payload = openEnvelope('search', sent.value, 'AvailabilityResponse')
  if (!payload.ok) return payload

  const properties: SupplierProperty[] = []
  for (const hotel of list(payload.value, 'HotelList', 'Hotel')) {
    const mapped = toProperty(hotel)
    if (!mapped.ok) return mapped
    properties.push(mapped.value)
  }

  return ok({
    supplier: SUPPLIER,
    checkIn: criteria.checkIn,
    checkOut: criteria.checkOut,
    properties,
  })
}

async function priceCheck(
  http: SupplierHttp,
  supplierRatePlanId: string,
  stay: { readonly checkIn: string; readonly checkOut: string },
): Promise<Result<PriceCheckResult, SupplierError>> {
  const dates = stayNodes(stay)
  if (dates === undefined) return err(fail('priceCheck', 'tanggal menginap tidak sah'))

  const sent = await soapCall(
    http,
    'priceCheck',
    'RateCheck',
    `<RateCheckRequest><RateCode>${supplierRatePlanId}</RateCode>${dates}</RateCheckRequest>`,
  )
  if (!sent.ok) return sent

  const payload = openEnvelope('priceCheck', sent.value, 'RateCheckResponse')
  if (!payload.ok) return payload

  const total = amountOf(payload.value, 'Amount', 'priceCheck')
  if (!total.ok) return total

  const changed = yesNo(text(payload.value, 'Changed'))
  if (changed === undefined) return err(fail('priceCheck', '<Changed> bukan Y atau N'))

  const refundable = yesNo(text(payload.value, 'Refundable'))
  if (refundable === undefined) return err(fail('priceCheck', '<Refundable> bukan Y atau N'))

  return ok({
    supplierRatePlanId: text(payload.value, 'RateCode') ?? supplierRatePlanId,
    total: total.value,
    changed,
    cancellationPolicy: cancellationPolicy(refundable),
  })
}

async function hold(
  http: SupplierHttp,
  supplierRatePlanId: string,
  stay: { readonly checkIn: string; readonly checkOut: string },
  guests: number,
): Promise<Result<HoldResult, SupplierError>> {
  const dates = stayNodes(stay)
  if (dates === undefined) return err(fail('hold', 'tanggal menginap tidak sah'))

  const sent = await soapCall(
    http,
    'hold',
    'Hold',
    `<HoldRequest><RateCode>${supplierRatePlanId}</RateCode>${dates}<PaxCount>${String(guests)}</PaxCount></HoldRequest>`,
  )
  if (!sent.ok) return sent

  const payload = openEnvelope('hold', sent.value, 'HoldResponse')
  if (!payload.ok) return payload

  const total = amountOf(payload.value, 'Amount', 'hold')
  if (!total.ok) return total

  const holdCode = text(payload.value, 'HoldCode')
  const expiresAt = text(payload.value, 'ExpiresAt')
  if (holdCode === undefined || expiresAt === undefined) {
    return err(fail('hold', 'tidak ada <HoldCode> atau <ExpiresAt>'))
  }

  return ok({ supplierHoldId: holdCode, expiresAt, total: total.value })
}

async function book(
  http: SupplierHttp,
  supplierHoldId: string,
  guest: GuestDetails,
  idempotencyKey: string,
): Promise<Result<BookingResult, SupplierError>> {
  const sent = await http.send({
    operation: 'book',
    method: 'POST',
    path: '/soap',
    contentType: 'text/xml',
    headers: { SOAPAction: 'Book' },
    idempotencyKey,
    body: envelope(
      `<BookRequest><HoldCode>${supplierHoldId}</HoldCode><GuestName>${guest.fullName}</GuestName><ClientReference>${idempotencyKey}</ClientReference></BookRequest>`,
    ),
  })
  if (!sent.ok) return sent

  const payload = openEnvelope('book', sent.value, 'BookResponse')
  return payload.ok ? toBooking(payload.value, 'book') : payload
}

async function cancel(
  http: SupplierHttp,
  bookingReference: string,
): Promise<Result<void, SupplierError>> {
  const sent = await soapCall(
    http,
    'cancel',
    'Cancel',
    `<CancelRequest><BookingCode>${bookingReference}</BookingCode></CancelRequest>`,
  )
  if (!sent.ok) return sent

  const payload = openEnvelope('cancel', sent.value, 'CancelResponse')
  return payload.ok ? ok(undefined) : err(payload.error)
}

async function retrieve(
  http: SupplierHttp,
  selector: string,
): Promise<Result<BookingResult, SupplierError>> {
  const sent = await soapCall(
    http,
    'getBooking',
    'Retrieve',
    `<RetrieveRequest>${selector}</RetrieveRequest>`,
  )
  if (!sent.ok) return sent

  const payload = openEnvelope('getBooking', sent.value, 'RetrieveResponse')
  return payload.ok ? toBooking(payload.value, 'getBooking') : payload
}

function toBooking(payload: XmlNode, operation: Operation): Result<BookingResult, SupplierError> {
  const total = amountOf(payload, 'Amount', operation)
  if (!total.ok) return total

  const reference = text(payload, 'BookingCode')
  const status = text(payload, 'Status')
  if (reference === undefined || status === undefined) {
    return err(fail(operation, 'tidak ada <BookingCode> atau <Status>'))
  }

  if (status !== 'CONFIRMED' && status !== 'CANCELLED') {
    return err(fail(operation, `<Status> tidak dikenali: ${status}`))
  }

  const checkIn = calendarDateFromOrbit(text(payload, 'FromDate') ?? '')
  const checkOut = calendarDateFromOrbit(text(payload, 'ToDate') ?? '')

  return ok({
    supplier: SUPPLIER,
    bookingReference: reference,
    status,
    total: total.value,
    ...(checkIn === undefined ? {} : { checkIn }),
    ...(checkOut === undefined ? {} : { checkOut }),
  })
}

function toProperty(hotel: XmlNode): Result<SupplierProperty, SupplierError> {
  const code = text(hotel, 'Code')
  const name = text(hotel, 'Name')
  if (code === undefined || name === undefined) {
    return err(fail('search', 'hotel tanpa <Code> atau <Name>'))
  }

  const roomTypes: RoomType[] = []
  for (const room of list(hotel, 'RoomList', 'Room')) {
    const mapped = toRoomType(room)
    if (!mapped.ok) return mapped
    roomTypes.push(mapped.value)
  }

  const stars = intOf(text(hotel, 'Stars'))

  return ok({
    supplier: SUPPLIER,
    supplierPropertyId: code,
    name,
    ...(stars === undefined ? {} : { starRating: stars }),
    amenities: [],
    roomTypes,
  })
}

function toRoomType(room: XmlNode): Result<RoomType, SupplierError> {
  const code = text(room, 'Code')
  const name = text(room, 'Name')
  if (code === undefined || name === undefined) {
    return err(fail('search', 'kamar tanpa <Code> atau <Name>'))
  }

  const ratePlans: RatePlan[] = []
  for (const rate of list(room, 'RateList', 'Rate')) {
    const mapped = toRatePlan(rate)
    if (!mapped.ok) return mapped
    ratePlans.push(mapped.value)
  }

  const maxPax = intOf(text(room, 'MaxPax'))

  return ok({
    supplierRoomTypeId: code,
    name,
    ...(maxPax === undefined ? {} : { maxGuests: maxPax }),
    ratePlans,
  })
}

function toRatePlan(rate: XmlNode): Result<RatePlan, SupplierError> {
  const total = amountOf(rate, 'Amount', 'search')
  if (!total.ok) return total

  const nightly = amountOf(rate, 'NightlyAmount', 'search')
  if (!nightly.ok) return nightly

  const code = text(rate, 'RateCode')
  const refundable = yesNo(text(rate, 'Refundable'))
  const breakfast = yesNo(text(rate, 'Breakfast'))
  const allotment = intOf(text(rate, 'Allotment'))

  if (code === undefined || refundable === undefined || breakfast === undefined) {
    return err(fail('search', 'rate tanpa <RateCode>, <Refundable>, atau <Breakfast>'))
  }

  if (allotment === undefined) return err(fail('search', '<Allotment> bukan bilangan bulat'))

  return ok({
    supplierRatePlanId: code,
    name: text(rate, 'Description') ?? '',
    total: total.value,
    nightly: nightly.value,
    cancellationPolicy: cancellationPolicy(refundable),
    breakfastIncluded: breakfast,
    availability: { unitsLeft: allotment },
  })
}
