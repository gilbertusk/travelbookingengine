import { Router, type RequestHandler, type Response } from 'express'
import { z } from 'zod'
import type { Booking, OperationFailure } from '../../domain/booking.js'
import { supplierPropertyName } from '../../domain/supplier.js'
import { book, cancel, findBooking, hold, priceCheck } from '../../application/reservation.js'
import { search, type PropertyOffer } from '../../application/search.js'
import { pathParam, toSupplierAmount, type SupplierContext } from '../context.js'
import { mapFailure } from '../failure.js'

/**
 * NOVA — REST JSON, USD, snake_case, tanggal sebagai ISO datetime.
 *
 * Dua jebakan yang disengaja: harga dinyatakan dalam satuan utama dengan dua
 * desimal (bukan satuan terkecil), dan tanggal menginap dikirim sebagai
 * datetime berzona UTC. Adapter yang memotong begitu saja bagian tanggalnya
 * akan salah satu malam untuk properti di sebelah timur UTC.
 */

const CODE = 'NOVA' as const

const dateFromIso = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), 'bukan datetime yang sah')
  .transform((value) => value.slice(0, 10))

const occupancy = z.object({ adults: z.number().int().positive().max(10) })

const searchSchema = z.object({
  destination: z.string().min(2),
  arrival_date: dateFromIso,
  departure_date: dateFromIso,
  occupancy,
})

const rateCheckSchema = z.object({
  option_code: z.string(),
  arrival_date: dateFromIso,
  departure_date: dateFromIso,
})

const holdSchema = rateCheckSchema.extend({ occupancy })

const confirmSchema = z.object({
  hold_reference: z.string(),
  lead_guest: z.object({ full_name: z.string().min(1) }),
  idempotency_key: z.string().min(1),
})

export function createNovaRouter(context: SupplierContext): Router {
  const router = Router()

  router.post('/search', searchHandler(context))
  router.post('/rate-check', rateCheckHandler(context))
  router.post('/reservations/hold', holdHandler(context))
  router.post('/reservations/confirm', confirmHandler(context))
  router.post('/reservations/cancel', cancelHandler(context))
  router.get('/reservations/:code', lookupHandler(context))

  return router
}

function searchHandler(context: SupplierContext): RequestHandler {
  return (req, res) => {
    const parsed = searchSchema.safeParse(req.body)
    if (!parsed.success) {
      badRequest(res)
      return
    }

    const result = search(context.deps, {
      supplier: CODE,
      city: parsed.data.destination,
      checkIn: parsed.data.arrival_date,
      checkOut: parsed.data.departure_date,
      guests: parsed.data.occupancy.adults,
    })
    if (!result.ok) {
      fail(res, result.error)
      return
    }

    res.json({ properties: result.value.map((offer) => toNovaProperty(offer, context)) })
  }
}

function rateCheckHandler(context: SupplierContext): RequestHandler {
  return (req, res) => {
    const parsed = rateCheckSchema.safeParse(req.body)
    const ratePlanId = parsed.success
      ? context.refs.ratePlanIdOf(CODE, parsed.data.option_code)
      : undefined

    if (!parsed.success || ratePlanId === undefined) {
      badRequest(res)
      return
    }

    const result = priceCheck(
      context.deps,
      {
        supplier: CODE,
        ratePlanId,
        checkIn: parsed.data.arrival_date,
        checkOut: parsed.data.departure_date,
      },
      context.chaos.get(CODE),
    )
    if (!result.ok) {
      fail(res, result.error)
      return
    }

    res.json({
      option_code: parsed.data.option_code,
      total_rate: usd(result.value.totalMinorIdr),
      rate_changed: result.value.changed,
    })
  }
}

function holdHandler(context: SupplierContext): RequestHandler {
  return (req, res) => {
    const parsed = holdSchema.safeParse(req.body)
    const ratePlanId = parsed.success
      ? context.refs.ratePlanIdOf(CODE, parsed.data.option_code)
      : undefined

    if (!parsed.success || ratePlanId === undefined) {
      badRequest(res)
      return
    }

    const result = hold(context.deps, {
      supplier: CODE,
      ratePlanId,
      checkIn: parsed.data.arrival_date,
      checkOut: parsed.data.departure_date,
      guests: parsed.data.occupancy.adults,
    })
    if (!result.ok) {
      fail(res, result.error)
      return
    }

    res.status(201).json({
      hold_reference: result.value.ref,
      expires_at: new Date(result.value.expiresAtMs).toISOString(),
      total_rate: usd(result.value.priceMinorIdr),
    })
  }
}

function confirmHandler(context: SupplierContext): RequestHandler {
  return (req, res) => {
    const parsed = confirmSchema.safeParse(req.body)
    if (!parsed.success) {
      badRequest(res)
      return
    }

    const result = book(context.deps, {
      supplier: CODE,
      holdRef: parsed.data.hold_reference,
      guestName: parsed.data.lead_guest.full_name,
      idempotencyKey: parsed.data.idempotency_key,
    })
    if (!result.ok) {
      fail(res, result.error)
      return
    }

    res.status(result.value.replayed ? 200 : 201).json(toNovaReservation(result.value.booking))
  }
}

function cancelHandler(context: SupplierContext): RequestHandler {
  return (req, res) => {
    const parsed = z.object({ reservation_code: z.string() }).safeParse(req.body)
    if (!parsed.success) {
      badRequest(res)
      return
    }

    const result = cancel(context.deps, {
      supplier: CODE,
      bookingRef: parsed.data.reservation_code,
    })
    if (!result.ok) {
      fail(res, result.error)
      return
    }

    res.json(toNovaReservation(result.value))
  }
}

function lookupHandler(context: SupplierContext): RequestHandler {
  return (req, res) => {
    const byKey = req.query.idempotency_key
    const isLookupByKey = pathParam(req, 'code') === 'lookup' && typeof byKey === 'string'

    const result = findBooking(context.deps, {
      supplier: CODE,
      ...(isLookupByKey ? { idempotencyKey: byKey } : { bookingRef: pathParam(req, 'code') }),
    })
    if (!result.ok) {
      fail(res, result.error)
      return
    }

    res.json(toNovaReservation(result.value))
  }
}

function usd(minorIdr: number): { value: string; currency_code: 'USD' } {
  return { value: toSupplierAmount(minorIdr, 'USD').decimal, currency_code: 'USD' }
}

function badRequest(res: Response): void {
  res.status(400).json({ error_code: 'INVALID_REQUEST', error_message: 'permintaan tidak sah' })
}

function fail(res: Response, failure: OperationFailure): void {
  const [status, code] = mapFailure(failure)
  res.status(status).json({ error_code: code, error_message: failure.kind })
}

function toNovaProperty(offer: PropertyOffer, context: SupplierContext): unknown {
  return {
    property_code: context.refs.propertyRef(CODE, offer.property.id),
    property_name: supplierPropertyName(CODE, offer.property.name),
    star_rating: offer.property.starRating,
    location: { latitude: offer.property.latitude, longitude: offer.property.longitude },
    room_options: offer.rooms.flatMap((room) =>
      room.rates.map((rate) => ({
        option_code: context.refs.rateRef(CODE, rate.ratePlan.id),
        option_name: `${room.roomType.name} — ${rate.ratePlan.name}`,
        max_occupancy: room.roomType.maxGuests,
        nightly_rate: usd(rate.nightlyMinorIdr),
        total_rate: usd(rate.totalMinorIdr),
        is_refundable: rate.ratePlan.refundable,
        includes_breakfast: rate.ratePlan.breakfastIncluded,
        units_remaining: rate.unitsLeft,
      })),
    ),
  }
}

function toNovaReservation(booking: Booking): unknown {
  return {
    reservation_code: booking.ref,
    reservation_status: booking.status === 'CONFIRMED' ? 'confirmed' : 'cancelled',
    total_rate: usd(booking.amountMinorIdr),
    arrival_date: `${booking.checkIn}T00:00:00Z`,
    departure_date: `${booking.checkOut}T00:00:00Z`,
  }
}
