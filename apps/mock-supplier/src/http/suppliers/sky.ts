import { Router, type RequestHandler, type Response } from 'express'
import { z } from 'zod'
import type { Booking, OperationFailure } from '../../domain/booking.js'
import { supplierPropertyName } from '../../domain/supplier.js'
import { book, cancel, findBooking, hold, priceCheck } from '../../application/reservation.js'
import { search, type PropertyOffer } from '../../application/search.js'
import { isoDate, pathParam, toSupplierAmount, type SupplierContext } from '../context.js'
import { mapFailure } from '../failure.js'

/**
 * SKY — REST JSON, IDR, camelCase, harga dalam satuan terkecil.
 *
 * Supplier paling lurus di antara kelimanya. Dipakai sebagai pembanding: bila
 * sebuah persoalan muncul di SKY juga, persoalannya ada di sistem kita, bukan
 * pada keanehan format supplier.
 *
 * Setiap rute dibangun oleh pabrik handler tersendiri. Pola ini dipakai di
 * seluruh supplier — factory router hanya mendaftarkan, tidak memuat logika.
 */

const CODE = 'SKY' as const

const searchSchema = z.object({
  city: z.string().min(2),
  checkIn: z.string(),
  checkOut: z.string(),
  guests: z.number().int().positive().max(10).default(2),
})

const verifySchema = z.object({
  rateId: z.string(),
  checkIn: z.string(),
  checkOut: z.string(),
})

const holdSchema = verifySchema.extend({ guests: z.number().int().positive().max(10) })

const bookSchema = z.object({
  holdId: z.string(),
  guestName: z.string().min(1),
  idempotencyKey: z.string().min(1),
})

export function createSkyRouter(context: SupplierContext): Router {
  const router = Router()

  router.post('/availability', searchHandler(context))
  router.post('/rates/verify', verifyHandler(context))
  router.post('/holds', holdHandler(context))
  router.post('/bookings', bookHandler(context))
  router.delete('/bookings/:bookingId', cancelHandler(context))
  router.get('/bookings/:bookingId', lookupByRefHandler(context))
  router.get('/bookings', lookupByKeyHandler(context))

  return router
}

function searchHandler(context: SupplierContext): RequestHandler {
  return (req, res) => {
    const parsed = searchSchema.safeParse(req.body)
    if (!parsed.success) {
      badRequest(res)
      return
    }

    const result = search(context.deps, { supplier: CODE, ...parsed.data })
    if (!result.ok) {
      sendFailure(res, result.error)
      return
    }

    res.json({ results: result.value.map((offer) => toSkyHotel(offer, context)) })
  }
}

function verifyHandler(context: SupplierContext): RequestHandler {
  return (req, res) => {
    const parsed = verifySchema.safeParse(req.body)
    const ratePlanId = parsed.success
      ? context.refs.ratePlanIdOf(CODE, parsed.data.rateId)
      : undefined

    if (!parsed.success || ratePlanId === undefined) {
      badRequest(res)

      return
    }

    const result = priceCheck(
      context.deps,
      { supplier: CODE, ratePlanId, checkIn: parsed.data.checkIn, checkOut: parsed.data.checkOut },
      context.chaos.get(CODE),
    )
    if (!result.ok) {
      sendFailure(res, result.error)
      return
    }

    res.json({
      rateId: parsed.data.rateId,
      price: money(result.value.totalMinorIdr),
      changed: result.value.changed,
    })
  }
}

function holdHandler(context: SupplierContext): RequestHandler {
  return (req, res) => {
    const parsed = holdSchema.safeParse(req.body)
    const ratePlanId = parsed.success
      ? context.refs.ratePlanIdOf(CODE, parsed.data.rateId)
      : undefined

    if (!parsed.success || ratePlanId === undefined) {
      badRequest(res)

      return
    }

    const result = hold(context.deps, { supplier: CODE, ratePlanId, ...parsed.data })
    if (!result.ok) {
      sendFailure(res, result.error)
      return
    }

    res.status(201).json({
      holdId: result.value.ref,
      expiresAt: isoDate(result.value.expiresAtMs),
      price: money(result.value.priceMinorIdr),
    })
  }
}

function bookHandler(context: SupplierContext): RequestHandler {
  return (req, res) => {
    const parsed = bookSchema.safeParse(req.body)
    if (!parsed.success) {
      badRequest(res)
      return
    }

    const result = book(context.deps, {
      supplier: CODE,
      holdRef: parsed.data.holdId,
      guestName: parsed.data.guestName,
      idempotencyKey: parsed.data.idempotencyKey,
    })
    if (!result.ok) {
      sendFailure(res, result.error)
      return
    }

    res.status(result.value.replayed ? 200 : 201).json(toSkyBooking(result.value.booking))
  }
}

function cancelHandler(context: SupplierContext): RequestHandler {
  return (req, res) => {
    const result = cancel(context.deps, { supplier: CODE, bookingRef: pathParam(req, 'bookingId') })
    if (!result.ok) {
      sendFailure(res, result.error)
      return
    }

    res.json(toSkyBooking(result.value))
  }
}

function lookupByRefHandler(context: SupplierContext): RequestHandler {
  return (req, res) => {
    const result = findBooking(context.deps, {
      supplier: CODE,
      bookingRef: pathParam(req, 'bookingId'),
    })
    if (!result.ok) {
      sendFailure(res, result.error)
      return
    }

    res.json(toSkyBooking(result.value))
  }
}

function lookupByKeyHandler(context: SupplierContext): RequestHandler {
  return (req, res) => {
    const key = req.query.idempotencyKey
    if (typeof key !== 'string') {
      badRequest(res)
      return
    }

    const result = findBooking(context.deps, { supplier: CODE, idempotencyKey: key })
    if (!result.ok) {
      sendFailure(res, result.error)
      return
    }

    res.json(toSkyBooking(result.value))
  }
}

function money(minorIdr: number): { amount: number; currency: 'IDR' } {
  return { amount: toSupplierAmount(minorIdr, 'IDR').minor, currency: 'IDR' }
}

function badRequest(res: Response): void {
  res.status(400).json({ error: 'INVALID_REQUEST' })
}

function sendFailure(res: Response, failure: OperationFailure): void {
  const [status, error] = mapFailure(failure)
  res.status(status).json({ error, detail: failure })
}

function toSkyHotel(offer: PropertyOffer, context: SupplierContext): unknown {
  return {
    hotelId: context.refs.propertyRef(CODE, offer.property.id),
    hotelName: supplierPropertyName(CODE, offer.property.name),
    address: offer.property.address,
    city: offer.property.city,
    stars: offer.property.starRating,
    latitude: offer.property.latitude,
    longitude: offer.property.longitude,
    amenities: offer.property.amenities,
    rooms: offer.rooms.map((room) => ({
      roomId: room.roomType.id,
      roomName: room.roomType.name,
      maxGuests: room.roomType.maxGuests,
      rates: room.rates.map((rate) => ({
        rateId: context.refs.rateRef(CODE, rate.ratePlan.id),
        rateName: rate.ratePlan.name,
        price: money(rate.totalMinorIdr),
        nightlyPrice: money(rate.nightlyMinorIdr),
        refundable: rate.ratePlan.refundable,
        breakfast: rate.ratePlan.breakfastIncluded,
        freeCancellationDays: rate.ratePlan.freeCancellationDays,
        unitsLeft: rate.unitsLeft,
      })),
    })),
  }
}

function toSkyBooking(booking: Booking): unknown {
  return {
    bookingId: booking.ref,
    status: booking.status,
    price: money(booking.amountMinorIdr),
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    guestName: booking.guestName,
  }
}
