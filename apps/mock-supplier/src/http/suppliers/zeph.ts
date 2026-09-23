import { Router, type RequestHandler, type Response } from 'express'
import { z } from 'zod'
import type { Booking, OperationFailure } from '../../domain/booking.js'
import { supplierPropertyName } from '../../domain/supplier.js'
import { book, cancel, findBooking, hold, priceCheck } from '../../application/reservation.js'
import { search, type PropertyOffer } from '../../application/search.js'
import { pathParam, toSupplierAmount, type SupplierContext } from '../context.js'
import { mapFailure } from '../failure.js'

/**
 * ZEPH — REST JSON, USD, harga sebagai string, amplop { status, payload }.
 *
 * Supplier paling tidak stabil: sekitar 15% permintaan gagal tanpa suntikan
 * apa pun. Harga sebagai string adalah jebakan yang sering terlewat — Number()
 * atas "75.50" bekerja sampai suatu hari supplier mengirim "1,250.00".
 */

const CODE = 'ZEPH' as const

const dates = z.object({ from: z.string(), to: z.string() })

const searchSchema = z.object({
  location: z.string().min(2),
  dates,
  pax: z.number().int().positive().max(10),
})

const offerSchema = z.object({ offer_ref: z.string(), dates })
const holdSchema = offerSchema.extend({ pax: z.number().int().positive().max(10) })

const bookSchema = z.object({
  hold_ref: z.string(),
  guest: z.string().min(1),
  request_id: z.string().min(1),
})

export function createZephRouter(context: SupplierContext): Router {
  const router = Router()

  router.post('/availability', searchHandler(context))
  router.post('/offers/price', priceHandler(context))
  router.post('/offers/hold', holdHandler(context))
  router.post('/bookings', bookHandler(context))
  router.post('/bookings/:ref/cancel', cancelHandler(context))
  router.get('/bookings/:ref', lookupByRefHandler(context))
  router.get('/bookings', lookupByRequestHandler(context))

  return router
}

function searchHandler(context: SupplierContext): RequestHandler {
  return (req, res) => {
    const parsed = searchSchema.safeParse(req.body)
    if (!parsed.success) {
      fail(res, { kind: 'invalid_request', reason: 'schema' })
      return
    }

    const result = search(context.deps, {
      supplier: CODE,
      city: parsed.data.location,
      checkIn: parsed.data.dates.from,
      checkOut: parsed.data.dates.to,
      guests: parsed.data.pax,
    })
    if (!result.ok) {
      fail(res, result.error)
      return
    }

    ok(res, { hotels: result.value.map((offer) => toZephHotel(offer, context)) })
  }
}

function priceHandler(context: SupplierContext): RequestHandler {
  return (req, res) => {
    const parsed = offerSchema.safeParse(req.body)
    const ratePlanId = parsed.success
      ? context.refs.ratePlanIdOf(CODE, parsed.data.offer_ref)
      : undefined

    if (!parsed.success || ratePlanId === undefined) {
      fail(res, { kind: 'not_found', what: 'rate_plan' })
      return
    }

    const result = priceCheck(
      context.deps,
      {
        supplier: CODE,
        ratePlanId,
        checkIn: parsed.data.dates.from,
        checkOut: parsed.data.dates.to,
      },
      context.chaos.get(CODE),
    )
    if (!result.ok) {
      fail(res, result.error)
      return
    }

    ok(res, {
      offer_ref: parsed.data.offer_ref,
      price: usdString(result.value.totalMinorIdr),
      currency: 'USD',
      changed: result.value.changed,
    })
  }
}

function holdHandler(context: SupplierContext): RequestHandler {
  return (req, res) => {
    const parsed = holdSchema.safeParse(req.body)
    const ratePlanId = parsed.success
      ? context.refs.ratePlanIdOf(CODE, parsed.data.offer_ref)
      : undefined

    if (!parsed.success || ratePlanId === undefined) {
      fail(res, { kind: 'not_found', what: 'rate_plan' })
      return
    }

    const result = hold(context.deps, {
      supplier: CODE,
      ratePlanId,
      checkIn: parsed.data.dates.from,
      checkOut: parsed.data.dates.to,
      guests: parsed.data.pax,
    })
    if (!result.ok) {
      fail(res, result.error)
      return
    }

    ok(
      res,
      {
        hold_ref: result.value.ref,
        expires_at: new Date(result.value.expiresAtMs).toISOString(),
        price: usdString(result.value.priceMinorIdr),
        currency: 'USD',
      },
      201,
    )
  }
}

function bookHandler(context: SupplierContext): RequestHandler {
  return (req, res) => {
    const parsed = bookSchema.safeParse(req.body)
    if (!parsed.success) {
      fail(res, { kind: 'invalid_request', reason: 'schema' })
      return
    }

    const result = book(context.deps, {
      supplier: CODE,
      holdRef: parsed.data.hold_ref,
      guestName: parsed.data.guest,
      idempotencyKey: parsed.data.request_id,
    })
    if (!result.ok) {
      fail(res, result.error)
      return
    }

    ok(res, toZephBooking(result.value.booking), result.value.replayed ? 200 : 201)
  }
}

function cancelHandler(context: SupplierContext): RequestHandler {
  return (req, res) => {
    const result = cancel(context.deps, { supplier: CODE, bookingRef: pathParam(req, 'ref') })
    if (!result.ok) {
      fail(res, result.error)
      return
    }

    ok(res, toZephBooking(result.value))
  }
}

function lookupByRefHandler(context: SupplierContext): RequestHandler {
  return (req, res) => {
    const result = findBooking(context.deps, { supplier: CODE, bookingRef: pathParam(req, 'ref') })
    if (!result.ok) {
      fail(res, result.error)
      return
    }

    ok(res, toZephBooking(result.value))
  }
}

function lookupByRequestHandler(context: SupplierContext): RequestHandler {
  return (req, res) => {
    const requestId = req.query.request_id
    if (typeof requestId !== 'string') {
      fail(res, { kind: 'invalid_request', reason: 'request_id' })
      return
    }

    const result = findBooking(context.deps, { supplier: CODE, idempotencyKey: requestId })
    if (!result.ok) {
      fail(res, result.error)
      return
    }

    ok(res, toZephBooking(result.value))
  }
}

function usdString(minorIdr: number): string {
  return toSupplierAmount(minorIdr, 'USD').decimal
}

function ok(res: Response, payload: unknown, status = 200): void {
  res.status(status).json({ status: 'ok', payload })
}

function fail(res: Response, failure: OperationFailure): void {
  const [status, code] = mapFailure(failure)
  res.status(status).json({ status: 'error', error: { code, kind: failure.kind } })
}

function toZephHotel(offer: PropertyOffer, context: SupplierContext): unknown {
  return {
    ref: context.refs.propertyRef(CODE, offer.property.id),
    name: supplierPropertyName(CODE, offer.property.name),
    rating: String(offer.property.starRating),
    rooms: offer.rooms.map((room) => ({
      ref: room.roomType.id,
      name: room.roomType.name,
      offers: room.rates.map((rate) => ({
        ref: context.refs.rateRef(CODE, rate.ratePlan.id),
        price: usdString(rate.totalMinorIdr),
        nightly: usdString(rate.nightlyMinorIdr),
        currency: 'USD',
        cancellable: rate.ratePlan.refundable,
        breakfast: rate.ratePlan.breakfastIncluded,
        remaining: String(rate.unitsLeft),
      })),
    })),
  }
}

function toZephBooking(booking: Booking): unknown {
  return {
    ref: booking.ref,
    state: booking.status.toLowerCase(),
    price: usdString(booking.amountMinorIdr),
    currency: 'USD',
    dates: { from: booking.checkIn, to: booking.checkOut },
  }
}
