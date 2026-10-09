import express, { Router, type Request, type Response } from 'express'
import { XMLParser } from 'fast-xml-parser'
import { buildXml, type XmlObject } from '../xml.js'
import type { OperationFailure } from '../../domain/booking.js'
import { supplierPropertyName } from '../../domain/supplier.js'
import { book, cancel, findBooking, hold, priceCheck } from '../../application/reservation.js'
import { search, type PropertyOffer } from '../../application/search.js'
import { toSupplierAmount, type SupplierContext } from '../context.js'
import { mapFailure } from '../failure.js'

/**
 * ORBIT — SOAP XML, IDR, PascalCase, tanggal DD/MM/YYYY.
 *
 * Supplier ini ada untuk satu alasan: memaksa lapisan adapter pada Step 10
 * benar-benar menjadi lapisan penerjemahan, bukan sekadar pemetaan nama field.
 * Format tanggal DD/MM/YYYY adalah jebakan nyata — 01/10/2026 terbaca sebagai
 * 10 Januari oleh parser yang mengasumsikan urutan Amerika, dan kesalahan itu
 * hanya terlihat pada tanggal di atas 12.
 */

const CODE = 'ORBIT' as const
const SOAP_ACTIONS = ['Availability', 'RateCheck', 'Hold', 'Book', 'Cancel', 'Retrieve'] as const
type SoapAction = (typeof SOAP_ACTIONS)[number]

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' })

export function createOrbitRouter(context: SupplierContext): Router {
  const router = Router()
  router.use(express.text({ type: ['text/xml', 'application/xml', 'application/soap+xml'] }))

  router.post('/soap', (req, res) => {
    const action = (req.header('soapaction') ?? '').replaceAll('"', '')

    if (!isSoapAction(action)) {
      sendFault(res, 400, 'UNKNOWN_ACTION')
      return
    }

    const body = readBody(req)
    if (body === undefined) {
      sendFault(res, 400, 'MALFORMED_ENVELOPE')
      return
    }

    handle({ action, body, context, res })
  })

  return router
}

function isSoapAction(value: string): value is SoapAction {
  return (SOAP_ACTIONS as readonly string[]).includes(value)
}

type XmlNode = Record<string, unknown>

function readBody(req: Request): XmlNode | undefined {
  if (typeof req.body !== 'string') return undefined

  try {
    const parsed: unknown = parser.parse(req.body)
    const envelope = (parsed as XmlNode).Envelope
    const soapBody = (envelope as XmlNode | undefined)?.Body
    return typeof soapBody === 'object' && soapBody !== null ? (soapBody as XmlNode) : undefined
  } catch {
    // Isi yang tidak dapat diurai adalah permintaan tidak sah, bukan kegagalan
    // sistem. Dicatat sebagai fault, bukan dilempar ke penangan galat umum.
    return undefined
  }
}

interface HandleParams {
  readonly action: SoapAction
  readonly body: XmlNode
  readonly context: SupplierContext
  readonly res: Response
}

const HANDLERS: Readonly<Record<SoapAction, (params: HandleParams) => void>> = {
  Availability: handleAvailability,
  RateCheck: handleRateCheck,
  Hold: handleHold,
  Book: handleBook,
  Cancel: handleCancel,
  Retrieve: handleRetrieve,
}

function handle(params: HandleParams): void {
  HANDLERS[params.action](params)
}

function handleAvailability({ body, context, res }: HandleParams): void {
  const request = node(body, 'AvailabilityRequest')
  const checkIn = fromOrbitDate(text(request, 'FromDate'))
  const checkOut = fromOrbitDate(text(request, 'ToDate'))

  if (checkIn === undefined || checkOut === undefined) {
    sendFault(res, 400, 'INVALID_DATE')
    return
  }

  const result = search(context.deps, {
    supplier: CODE,
    city: text(request, 'Location'),
    checkIn,
    checkOut,
    guests: Number(text(request, 'PaxCount')) || 2,
  })

  if (!result.ok) {
    sendFailure(res, result.error)
    return
  }

  sendXml(res, 200, {
    AvailabilityResponse: {
      HotelList: { Hotel: result.value.map((offer) => toOrbitHotel(offer, context)) },
    },
  })
}

function handleRateCheck({ body, context, res }: HandleParams): void {
  const request = node(body, 'RateCheckRequest')
  const ratePlanId = context.refs.ratePlanIdOf(CODE, text(request, 'RateCode'))
  const checkIn = fromOrbitDate(text(request, 'FromDate'))
  const checkOut = fromOrbitDate(text(request, 'ToDate'))

  if (ratePlanId === undefined || checkIn === undefined || checkOut === undefined) {
    sendFault(res, 404, 'RATE_NOT_FOUND')
    return
  }

  const result = priceCheck(
    context.deps,
    { supplier: CODE, ratePlanId, checkIn, checkOut },
    context.chaos.get(CODE),
  )

  if (!result.ok) {
    sendFailure(res, result.error)
    return
  }

  sendXml(res, 200, {
    RateCheckResponse: {
      RateCode: text(request, 'RateCode'),
      Amount: amountNode(result.value.totalMinorIdr),
      Changed: result.value.changed ? 'Y' : 'N',
      Refundable: result.value.policy.refundable ? 'Y' : 'N',
    },
  })
}

function handleHold({ body, context, res }: HandleParams): void {
  const request = node(body, 'HoldRequest')
  const ratePlanId = context.refs.ratePlanIdOf(CODE, text(request, 'RateCode'))
  const checkIn = fromOrbitDate(text(request, 'FromDate'))
  const checkOut = fromOrbitDate(text(request, 'ToDate'))

  if (ratePlanId === undefined || checkIn === undefined || checkOut === undefined) {
    sendFault(res, 404, 'RATE_NOT_FOUND')
    return
  }

  const result = hold(context.deps, {
    supplier: CODE,
    ratePlanId,
    checkIn,
    checkOut,
    guests: Number(text(request, 'PaxCount')) || 2,
  })

  if (!result.ok) {
    sendFailure(res, result.error)
    return
  }

  sendXml(res, 200, {
    HoldResponse: {
      HoldCode: result.value.ref,
      ExpiresAt: new Date(result.value.expiresAtMs).toISOString(),
      Amount: amountNode(result.value.priceMinorIdr),
    },
  })
}

function handleBook({ body, context, res }: HandleParams): void {
  const request = node(body, 'BookRequest')
  const result = book(context.deps, {
    supplier: CODE,
    holdRef: text(request, 'HoldCode'),
    guestName: text(request, 'GuestName'),
    idempotencyKey: text(request, 'ClientReference'),
  })

  if (!result.ok) {
    sendFailure(res, result.error)
    return
  }

  sendXml(res, 200, {
    BookResponse: {
      ...toOrbitBooking(result.value.booking),
      Replayed: result.value.replayed ? 'Y' : 'N',
    },
  })
}

function handleCancel({ body, context, res }: HandleParams): void {
  const request = node(body, 'CancelRequest')
  const result = cancel(context.deps, {
    supplier: CODE,
    bookingRef: text(request, 'BookingCode'),
  })

  if (!result.ok) {
    sendFailure(res, result.error)
    return
  }

  sendXml(res, 200, { CancelResponse: toOrbitBooking(result.value) })
}

function handleRetrieve({ body, context, res }: HandleParams): void {
  const request = node(body, 'RetrieveRequest')
  const bookingCode = text(request, 'BookingCode')
  const clientReference = text(request, 'ClientReference')

  const result = findBooking(context.deps, {
    supplier: CODE,
    ...(bookingCode === '' ? {} : { bookingRef: bookingCode }),
    ...(clientReference === '' ? {} : { idempotencyKey: clientReference }),
  })

  if (!result.ok) {
    sendFailure(res, result.error)
    return
  }

  sendXml(res, 200, { RetrieveResponse: toOrbitBooking(result.value) })
}

function node(parent: XmlNode, name: string): XmlNode {
  const value = parent[name]
  return typeof value === 'object' && value !== null ? (value as XmlNode) : {}
}

function text(parent: XmlNode, name: string): string {
  const value = parent[name]

  // Elemen XML yang punya anak diurai menjadi objek. Untuk field yang
  // diharapkan berisi teks, itu berarti permintaannya salah bentuk — bukan
  // sesuatu yang boleh diam-diam menjadi '[object Object]'.
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)

  return ''
}

/** DD/MM/YYYY → YYYY-MM-DD. Urutan hari-bulan disengaja, bukan salah ketik. */
export function fromOrbitDate(value: string): string | undefined {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value)
  if (match === null) return undefined

  const [, day, month, year] = match
  return `${String(year)}-${String(month)}-${String(day)}`
}

export function toOrbitDate(value: string): string {
  const [year, month, day] = value.split('-')
  return `${String(day)}/${String(month)}/${String(year)}`
}

function amountNode(minorIdr: number): XmlObject {
  return { '@_Currency': 'IDR', '#text': toSupplierAmount(minorIdr, 'IDR').minor }
}

function toOrbitHotel(offer: PropertyOffer, context: SupplierContext): XmlObject {
  return {
    Code: context.refs.propertyRef(CODE, offer.property.id),
    Name: supplierPropertyName(CODE, offer.property.name),
    Stars: offer.property.starRating,
    RoomList: {
      Room: offer.rooms.map((room) => ({
        Code: room.roomType.id,
        Name: room.roomType.name,
        MaxPax: room.roomType.maxGuests,
        RateList: {
          Rate: room.rates.map((rate) => ({
            RateCode: context.refs.rateRef(CODE, rate.ratePlan.id),
            Description: rate.ratePlan.name,
            Amount: amountNode(rate.totalMinorIdr),
            NightlyAmount: amountNode(rate.nightlyMinorIdr),
            Refundable: rate.ratePlan.refundable ? 'Y' : 'N',
            Breakfast: rate.ratePlan.breakfastIncluded ? 'Y' : 'N',
            Allotment: rate.unitsLeft,
          })),
        },
      })),
    },
  }
}

function toOrbitBooking(booking: {
  ref: string
  status: string
  amountMinorIdr: number
  checkIn: string
  checkOut: string
}): XmlObject {
  return {
    BookingCode: booking.ref,
    Status: booking.status,
    Amount: amountNode(booking.amountMinorIdr),
    FromDate: toOrbitDate(booking.checkIn),
    ToDate: toOrbitDate(booking.checkOut),
  }
}

function sendXml(res: Response, status: number, body: XmlObject): void {
  res
    .status(status)
    .type('text/xml')
    .send(buildXml({ Envelope: { Body: body } }))
}

function sendFault(res: Response, status: number, code: string): void {
  sendXml(res, status, { Fault: { Code: code, Message: code } })
}

function sendFailure(res: Response, failure: OperationFailure): void {
  const [status, code] = mapFailure(failure)
  sendFault(res, status, code)
}
