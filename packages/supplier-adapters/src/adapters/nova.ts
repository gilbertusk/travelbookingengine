import { err, ok, type Result } from '@tbe/shared-kernel'
import { z } from 'zod'
import { calendarDateFromInstant } from '../canonical/dates.js'
import { money, parseDecimalAmount } from '../canonical/money.js'
import { cancellationPolicy } from '../canonical/model.js'
import type {
  BookingResult,
  HoldResult,
  PriceCheckResult,
  RoomType,
  SupplierProperty,
  SupplierSearchResult,
} from '../canonical/model.js'
import type { SupplierError } from '../errors/supplier-error.js'
import type { Operation, SupplierHttp } from '../http/client.js'
import { invalidResponse } from '../http/failure.js'
import type { GuestDetails, SearchCriteria, SupplierGateway } from '../ports/supplier-gateway.js'
import { decodeJson, type AdapterContext } from './shared.js'

/**
 * NOVA — REST JSON, USD, snake_case, tanggal sebagai ISO datetime.
 *
 * Tiga hal yang harus ditangani adapter ini dan tidak ada di SKY:
 *
 * 1. Harga dinyatakan dalam satuan utama berdesimal ("267.83"), bukan satuan
 *    terkecil. Diubah dengan operasi string, bukan perkalian pecahan.
 * 2. Tanggal menginap datang sebagai datetime berzona. Diurai sungguhan dalam
 *    UTC, bukan dipotong sepuluh karakter pertama.
 * 3. NOVA tidak mengelompokkan rate plan ke dalam jenis kamar — ia mengirim
 *    daftar `room_options` yang datar. Pengelompokan dipulihkan dari
 *    `option_name`, dan itu satu-satunya keterangan yang NOVA berikan.
 */

const SUPPLIER = 'NOVA' as const

const novaAmount = z.object({
  value: z.string().min(1),
  currency_code: z.literal('USD'),
})

const novaOption = z.object({
  option_code: z.string().min(1),
  option_name: z.string(),
  max_occupancy: z.number().int().positive().optional(),
  nightly_rate: novaAmount,
  total_rate: novaAmount,
  is_refundable: z.boolean(),
  includes_breakfast: z.boolean(),
  units_remaining: z.number().int().nonnegative(),
})

const novaProperty = z.object({
  property_code: z.string().min(1),
  property_name: z.string().min(1),
  star_rating: z.number().min(0).max(5).optional(),
  location: z.object({ latitude: z.number(), longitude: z.number() }).optional(),
  room_options: z.array(novaOption),
})

const novaSearchResponse = z.object({ properties: z.array(novaProperty) })

const novaRateCheckResponse = z.object({
  option_code: z.string().min(1),
  total_rate: novaAmount,
  rate_changed: z.boolean(),
  is_refundable: z.boolean(),
})

const novaHoldResponse = z.object({
  hold_reference: z.string().min(1),
  expires_at: z.iso.datetime(),
  total_rate: novaAmount,
})

const novaReservationResponse = z.object({
  reservation_code: z.string().min(1),
  reservation_status: z.enum(['confirmed', 'cancelled']),
  total_rate: novaAmount,
  arrival_date: z.string(),
  departure_date: z.string(),
})

/** NOVA menaruh kode galat pada `error_code`. */
function errorCodeOf(body: unknown): string | undefined {
  const code = (body as { error_code?: unknown } | undefined)?.error_code
  return typeof code === 'string' ? code : undefined
}

function context(operation: Operation): AdapterContext {
  return { supplier: SUPPLIER, operation }
}

/** Tanggal menginap dikirim sebagai tengah malam UTC, sesuai yang NOVA harapkan. */
function toNovaDate(calendarDate: string): string {
  return `${calendarDate}T00:00:00Z`
}

function toMoney(
  amount: z.infer<typeof novaAmount>,
  operation: Operation,
): Result<ReturnType<typeof money>, SupplierError> {
  const minor = parseDecimalAmount(amount.value, 'USD')

  return minor === undefined
    ? err(invalidResponse(SUPPLIER, operation, `harga "${amount.value}" bukan desimal yang sah`))
    : ok(money(minor, 'USD'))
}

export function createNovaAdapter(http: SupplierHttp): SupplierGateway {
  return {
    supplier: SUPPLIER,
    search: async (criteria) => await search(http, criteria),
    priceCheck: async (optionCode, stay) => await priceCheck(http, optionCode, stay),
    hold: async (optionCode, stay, guests) => await hold(http, optionCode, stay, guests),
    book: async (holdRef, guest, key) => await book(http, holdRef, guest, key),
    cancel: async (reference) => await cancel(http, reference),
    getBooking: async (reference) => await lookup(http, `/reservations/${encode(reference)}`),
    findBookingByIdempotencyKey: async (key) =>
      await lookup(http, `/reservations/lookup?idempotency_key=${encode(key)}`),
  }
}

function encode(value: string): string {
  return encodeURIComponent(value)
}

async function search(
  http: SupplierHttp,
  criteria: SearchCriteria,
): Promise<Result<SupplierSearchResult, SupplierError>> {
  const sent = await http.send({
    operation: 'search',
    method: 'POST',
    path: '/search',
    contentType: 'application/json',
    body: JSON.stringify({
      destination: criteria.city,
      arrival_date: toNovaDate(criteria.checkIn),
      departure_date: toNovaDate(criteria.checkOut),
      occupancy: { adults: criteria.guests },
    }),
  })
  if (!sent.ok) return sent

  const decoded = decodeJson(context('search'), sent.value, novaSearchResponse, errorCodeOf)
  if (!decoded.ok) return decoded

  const properties: SupplierProperty[] = []
  for (const property of decoded.value.properties) {
    const mapped = toProperty(property)
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
  const sent = await http.send({
    operation: 'priceCheck',
    method: 'POST',
    path: '/rate-check',
    contentType: 'application/json',
    body: JSON.stringify({
      option_code: supplierRatePlanId,
      arrival_date: toNovaDate(stay.checkIn),
      departure_date: toNovaDate(stay.checkOut),
    }),
  })
  if (!sent.ok) return sent

  const decoded = decodeJson(context('priceCheck'), sent.value, novaRateCheckResponse, errorCodeOf)
  if (!decoded.ok) return decoded

  const total = toMoney(decoded.value.total_rate, 'priceCheck')
  if (!total.ok) return total

  return ok({
    supplierRatePlanId: decoded.value.option_code,
    total: total.value,
    changed: decoded.value.rate_changed,
    cancellationPolicy: cancellationPolicy(decoded.value.is_refundable),
  })
}

async function hold(
  http: SupplierHttp,
  supplierRatePlanId: string,
  stay: { readonly checkIn: string; readonly checkOut: string },
  guests: number,
): Promise<Result<HoldResult, SupplierError>> {
  const sent = await http.send({
    operation: 'hold',
    method: 'POST',
    path: '/reservations/hold',
    contentType: 'application/json',
    body: JSON.stringify({
      option_code: supplierRatePlanId,
      arrival_date: toNovaDate(stay.checkIn),
      departure_date: toNovaDate(stay.checkOut),
      occupancy: { adults: guests },
    }),
  })
  if (!sent.ok) return sent

  const decoded = decodeJson(context('hold'), sent.value, novaHoldResponse, errorCodeOf)
  if (!decoded.ok) return decoded

  const total = toMoney(decoded.value.total_rate, 'hold')
  if (!total.ok) return total

  return ok({
    supplierHoldId: decoded.value.hold_reference,
    expiresAt: decoded.value.expires_at,
    total: total.value,
  })
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
    path: '/reservations/confirm',
    contentType: 'application/json',
    idempotencyKey,
    body: JSON.stringify({
      hold_reference: supplierHoldId,
      lead_guest: { full_name: guest.fullName },
      idempotency_key: idempotencyKey,
    }),
  })
  if (!sent.ok) return sent

  return toBooking(
    decodeJson(context('book'), sent.value, novaReservationResponse, errorCodeOf),
    'book',
  )
}

async function cancel(
  http: SupplierHttp,
  bookingReference: string,
): Promise<Result<void, SupplierError>> {
  const sent = await http.send({
    operation: 'cancel',
    method: 'POST',
    path: '/reservations/cancel',
    contentType: 'application/json',
    body: JSON.stringify({ reservation_code: bookingReference }),
  })
  if (!sent.ok) return sent

  const decoded = decodeJson(context('cancel'), sent.value, novaReservationResponse, errorCodeOf)
  return decoded.ok ? ok(undefined) : err(decoded.error)
}

async function lookup(
  http: SupplierHttp,
  path: string,
): Promise<Result<BookingResult, SupplierError>> {
  const sent = await http.send({ operation: 'getBooking', method: 'GET', path })
  if (!sent.ok) return sent

  return toBooking(
    decodeJson(context('getBooking'), sent.value, novaReservationResponse, errorCodeOf),
    'getBooking',
  )
}

function toBooking(
  decoded: Result<z.infer<typeof novaReservationResponse>, SupplierError>,
  operation: Operation,
): Result<BookingResult, SupplierError> {
  if (!decoded.ok) return decoded

  const total = toMoney(decoded.value.total_rate, operation)
  if (!total.ok) return total

  const checkIn = calendarDateFromInstant(decoded.value.arrival_date)
  const checkOut = calendarDateFromInstant(decoded.value.departure_date)

  if (checkIn === undefined || checkOut === undefined) {
    return err(invalidResponse(SUPPLIER, operation, 'tanggal menginap bukan datetime yang sah'))
  }

  return ok({
    supplier: SUPPLIER,
    bookingReference: decoded.value.reservation_code,
    status: decoded.value.reservation_status === 'confirmed' ? 'CONFIRMED' : 'CANCELLED',
    total: total.value,
    checkIn,
    checkOut,
  })
}

/**
 * Memulihkan pengelompokan jenis kamar dari nama pilihan.
 *
 * NOVA mengirim `"Superior — Refundable with Breakfast"`. Pemisahnya adalah
 * satu-satunya keterangan yang ia berikan tentang kamar mana yang mana.
 * Kalau pemisah itu tidak ada, pengelompokan TIDAK ditebak — pilihan menjadi
 * jenis kamarnya sendiri. Mengarang pengelompokan dari kemiripan nama akan
 * menggabungkan kamar yang sebenarnya berbeda.
 */
const OPTION_SEPARATOR = ' — '

function splitOptionName(optionName: string): { room: string; ratePlan: string } {
  const index = optionName.indexOf(OPTION_SEPARATOR)
  if (index === -1) return { room: optionName, ratePlan: optionName }

  return {
    room: optionName.slice(0, index),
    ratePlan: optionName.slice(index + OPTION_SEPARATOR.length),
  }
}

function toProperty(
  property: z.infer<typeof novaProperty>,
): Result<SupplierProperty, SupplierError> {
  const grouped = new Map<string, RoomType>()

  for (const option of property.room_options) {
    const total = toMoney(option.total_rate, 'search')
    if (!total.ok) return total

    const nightly = toMoney(option.nightly_rate, 'search')
    if (!nightly.ok) return nightly

    const names = splitOptionName(option.option_name)
    const existing = grouped.get(names.room)

    const ratePlan = {
      supplierRatePlanId: option.option_code,
      name: names.ratePlan,
      total: total.value,
      nightly: nightly.value,
      cancellationPolicy: cancellationPolicy(option.is_refundable),
      breakfastIncluded: option.includes_breakfast,
      availability: { unitsLeft: option.units_remaining },
    }

    grouped.set(names.room, {
      supplierRoomTypeId: existing?.supplierRoomTypeId ?? names.room,
      name: names.room,
      ...(option.max_occupancy === undefined ? {} : { maxGuests: option.max_occupancy }),
      ratePlans: [...(existing?.ratePlans ?? []), ratePlan],
    })
  }

  return ok({
    supplier: SUPPLIER,
    supplierPropertyId: property.property_code,
    name: property.property_name,
    ...(property.star_rating === undefined ? {} : { starRating: property.star_rating }),
    ...(property.location === undefined
      ? {}
      : {
          coordinates: {
            latitude: property.location.latitude,
            longitude: property.location.longitude,
          },
        }),
    amenities: [],
    roomTypes: [...grouped.values()],
  })
}
