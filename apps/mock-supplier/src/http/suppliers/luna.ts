import { Router, type RequestHandler, type Response } from 'express'
import { z } from 'zod'
import type { Booking, OperationFailure } from '../../domain/booking.js'
import { supplierPropertyName } from '../../domain/supplier.js'
import { book, cancel, findBooking, hold, priceCheck } from '../../application/reservation.js'
import { search, type PropertyOffer } from '../../application/search.js'
import { toSupplierAmount, type SupplierContext } from '../context.js'
import { mapFailure } from '../failure.js'

/**
 * LUNA — REST JSON, IDR, tanggal sebagai epoch detik, nama field sangat pendek.
 *
 * Supplier paling lambat sekaligus yang paling menyiksa untuk dibaca manusia.
 * Tanggal sebagai epoch adalah jebakan yang nyata: mengubahnya kembali ke
 * tanggal lokal dengan zona waktu yang salah menggeser seluruh menginap satu
 * hari, dan kesalahan itu tidak terlihat sampai ada yang memesan di sekitar
 * tengah malam.
 */

const CODE = 'LUNA' as const

const epochToDate = z
  .number()
  .int()
  .transform((seconds) => new Date(seconds * 1_000).toISOString().slice(0, 10))

const searchSchema = z.object({
  q: z.object({
    loc: z.string().min(2),
    in: epochToDate,
    out: epochToDate,
    pax: z.number().int().positive().max(10),
  }),
})

const rateSchema = z.object({ pid: z.string(), in: epochToDate, out: epochToDate })
const holdSchema = rateSchema.extend({ pax: z.number().int().positive().max(10) })
const bookSchema = z.object({ h: z.string(), gn: z.string().min(1), ik: z.string().min(1) })

export function createLunaRouter(context: SupplierContext): Router {
  const router = Router()

  router.post('/availability', searchHandler(context))
  router.post('/rate', rateHandler(context))
  router.post('/hold', holdHandler(context))
  router.post('/book', bookHandler(context))
  router.post('/void', voidHandler(context))
  router.get('/bk', lookupHandler(context))

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
      city: parsed.data.q.loc,
      checkIn: parsed.data.q.in,
      checkOut: parsed.data.q.out,
      guests: parsed.data.q.pax,
    })
    if (!result.ok) {
      fail(res, result.error)
      return
    }

    res.json({ ok: true, data: { items: result.value.map((o) => toLunaItem(o, context)) } })
  }
}

function rateHandler(context: SupplierContext): RequestHandler {
  return (req, res) => {
    const parsed = rateSchema.safeParse(req.body)
    const ratePlanId = parsed.success ? context.refs.ratePlanIdOf(CODE, parsed.data.pid) : undefined

    if (!parsed.success || ratePlanId === undefined) {
      fail(res, { kind: 'not_found', what: 'rate_plan' })
      return
    }

    const result = priceCheck(
      context.deps,
      { supplier: CODE, ratePlanId, checkIn: parsed.data.in, checkOut: parsed.data.out },
      context.chaos.get(CODE),
    )
    if (!result.ok) {
      fail(res, result.error)
      return
    }

    res.json({
      ok: true,
      data: {
        pid: parsed.data.pid,
        amt: idr(result.value.totalMinorIdr),
        chg: result.value.changed,
        ref: result.value.policy.refundable ? 1 : 0,
      },
    })
  }
}

function holdHandler(context: SupplierContext): RequestHandler {
  return (req, res) => {
    const parsed = holdSchema.safeParse(req.body)
    const ratePlanId = parsed.success ? context.refs.ratePlanIdOf(CODE, parsed.data.pid) : undefined

    if (!parsed.success || ratePlanId === undefined) {
      fail(res, { kind: 'not_found', what: 'rate_plan' })
      return
    }

    const result = hold(context.deps, {
      supplier: CODE,
      ratePlanId,
      checkIn: parsed.data.in,
      checkOut: parsed.data.out,
      guests: parsed.data.pax,
    })
    if (!result.ok) {
      fail(res, result.error)
      return
    }

    res.status(201).json({
      ok: true,
      data: {
        h: result.value.ref,
        exp: Math.floor(result.value.expiresAtMs / 1_000),
        amt: idr(result.value.priceMinorIdr),
      },
    })
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
      holdRef: parsed.data.h,
      guestName: parsed.data.gn,
      idempotencyKey: parsed.data.ik,
    })
    if (!result.ok) {
      fail(res, result.error)
      return
    }

    res
      .status(result.value.replayed ? 200 : 201)
      .json({ ok: true, data: toLunaBooking(result.value.booking) })
  }
}

function voidHandler(context: SupplierContext): RequestHandler {
  return (req, res) => {
    const parsed = z.object({ b: z.string() }).safeParse(req.body)
    if (!parsed.success) {
      fail(res, { kind: 'invalid_request', reason: 'schema' })
      return
    }

    const result = cancel(context.deps, { supplier: CODE, bookingRef: parsed.data.b })
    if (!result.ok) {
      fail(res, result.error)
      return
    }

    res.json({ ok: true, data: toLunaBooking(result.value) })
  }
}

function lookupHandler(context: SupplierContext): RequestHandler {
  return (req, res) => {
    const { b, ik } = req.query

    const result = findBooking(context.deps, {
      supplier: CODE,
      ...(typeof b === 'string' ? { bookingRef: b } : {}),
      ...(typeof ik === 'string' ? { idempotencyKey: ik } : {}),
    })
    if (!result.ok) {
      fail(res, result.error)
      return
    }

    res.json({ ok: true, data: toLunaBooking(result.value) })
  }
}

function idr(minorIdr: number): number {
  return toSupplierAmount(minorIdr, 'IDR').minor
}

function fail(res: Response, failure: OperationFailure): void {
  const [status, code] = mapFailure(failure)
  // LUNA selalu membalas dengan amplop yang sama, bahkan saat gagal — kode
  // status HTTP-nya benar tetapi badan responsnya tetap ok:false.
  res.status(status).json({ ok: false, err: code })
}

function toLunaItem(offer: PropertyOffer, context: SupplierContext): unknown {
  return {
    hid: context.refs.propertyRef(CODE, offer.property.id),
    hname: supplierPropertyName(CODE, offer.property.name),
    st: offer.property.starRating,
    rt: offer.rooms.map((room) => ({
      rid: room.roomType.id,
      rname: room.roomType.name,
      mx: room.roomType.maxGuests,
      rp: room.rates.map((rate) => ({
        pid: context.refs.rateRef(CODE, rate.ratePlan.id),
        pname: rate.ratePlan.name,
        amt: idr(rate.totalMinorIdr),
        namt: idr(rate.nightlyMinorIdr),
        cur: 'IDR',
        ref: rate.ratePlan.refundable ? 1 : 0,
        bf: rate.ratePlan.breakfastIncluded ? 1 : 0,
        left: rate.unitsLeft,
      })),
    })),
  }
}

function toLunaBooking(booking: Booking): unknown {
  return {
    b: booking.ref,
    st: booking.status === 'CONFIRMED' ? 1 : 0,
    amt: idr(booking.amountMinorIdr),
    in: Math.floor(Date.parse(`${booking.checkIn}T00:00:00Z`) / 1_000),
    out: Math.floor(Date.parse(`${booking.checkOut}T00:00:00Z`) / 1_000),
  }
}
