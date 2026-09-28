import { money, moneySchema } from '@tbe/money'
import { AppError, NotFoundError, ValidationError, success, validate } from '@tbe/shared-kernel'
import { Router, type RequestHandler, type Response } from 'express'
import { z } from 'zod'
import { placeHold, type HoldResult } from '../application/place-hold.js'
import {
  acceptPriceChange,
  startPriceCheck,
  type PriceCheckResult,
} from '../application/price-check.js'
import { loadOwned } from '../application/persist.js'
import type { BookingDeps } from '../application/ports.js'
import { SUPPLIER_CODES } from '../domain/booking.js'
import { identity } from './identity.js'
import { bookingView } from './views.js'

/**
 * Antarmuka HTTP pemesanan (Step 17).
 *
 * Seluruh rute dilayani lewat api-gateway, yang mewajibkan autentikasi untuk
 * awalan /bookings dan meneruskan identitas sebagai `x-tbe-user-id`. Gateway
 * membuang header `x-tbe-*` kiriman klien sebelum menambahkan miliknya, jadi
 * header ini dapat dipercaya DI SINI — dan hanya di sini, di balik gateway.
 */

export { USER_ID_HEADER } from './identity.js'

const priceCheckBody = validate(
  z.object({
    idempotencyKey: z.string().min(1).max(200),
    supplier: z.enum(SUPPLIER_CODES),
    propertyId: z.string().min(1).max(200),
    city: z.string().min(1).max(120),
    ratePlanRef: z.string().min(1).max(200),
    checkIn: z.string(),
    checkOut: z.string(),
    guest: z.object({
      fullName: z.string().max(200),
      email: z.string().max(320),
      count: z.number().int(),
    }),
    /** Harga jual yang dilihat pengguna. Dibandingkan, tidak dipercaya. */
    displayedTotal: moneySchema,
  }),
  'body',
)

const acceptBody = validate(z.object({ bookingId: z.uuid() }), 'body')

const holdBody = validate(
  z.object({
    bookingId: z.uuid(),
    /** Ketersediaan yang terlihat di hasil pencarian. */
    unitsLeft: z.number().int().positive().max(1_000),
  }),
  'body',
)

export const bookingParams = validate(z.object({ id: z.uuid() }), 'params')

export function createBookingRouter(deps: BookingDeps): Router {
  const router = Router()

  // Identitas diperiksa SEBELUM isi permintaan: permintaan tanpa identitas
  // dijawab 401, bukan 400 yang membocorkan bentuk skema kepada siapa pun.
  router.post('/bookings/price-check', identity, priceCheckBody, priceCheckHandler(deps))
  router.post('/bookings/price-check/accept', identity, acceptBody, acceptHandler(deps))
  router.post('/bookings/hold', identity, holdBody, holdHandler(deps))
  router.get('/bookings/:id', identity, bookingParams, getHandler(deps))

  return router
}

function priceCheckHandler(deps: BookingDeps): RequestHandler {
  return (_req, res, next) => {
    const body = priceCheckBody.value(res)
    const userId = identity.value(res)

    const { amountMinor, currency } = body.displayedTotal
    void startPriceCheck(deps, {
      ...body,
      userId,
      displayedTotal: money(amountMinor, currency),
    }).then((result) => {
      respondToPriceCheck(res, next, result)
    }, next)
  }
}

function acceptHandler(deps: BookingDeps): RequestHandler {
  return (_req, res, next) => {
    const userId = identity.value(res)

    void acceptPriceChange(deps, { userId, bookingId: acceptBody.value(res).bookingId }).then(
      (result) => {
        respondToPriceCheck(res, next, result)
      },
      next,
    )
  }
}

function holdHandler(deps: BookingDeps): RequestHandler {
  return (_req, res, next) => {
    const userId = identity.value(res)

    void placeHold(deps, { ...holdBody.value(res), userId }).then((result) => {
      respondToHold(res, next, result)
    }, next)
  }
}

function getHandler(deps: BookingDeps): RequestHandler {
  return (_req, res, next) => {
    const userId = identity.value(res)

    void loadOwned(deps, userId, bookingParams.value(res).id).then((booking) => {
      if (booking === undefined) {
        next(new NotFoundError('Pemesanan tidak ditemukan'))
        return
      }
      res.json(success(bookingView(booking)))
    }, next)
  }
}

type Next = (error?: unknown) => void

/**
 * Hasil price check menjadi respons.
 *
 * Harga berubah dijawab 200, bukan 409: glosarium PRD menyatakan Rate Change
 * kondisi normal, bukan kegagalan. Klien membaca `priceCheck.outcome` dan
 * menampilkan harga lama, baru, dan selisihnya. Yang 409 hanyalah rate plan
 * yang sudah tidak tersedia — pemesanan itu berakhir.
 */
function respondToPriceCheck(res: Response, next: Next, result: PriceCheckResult): void {
  switch (result.kind) {
    case 'checked': {
      const view = bookingView(result.booking)
      if (view.priceCheck?.outcome === 'unavailable') {
        next(conflict('RATE_UNAVAILABLE', 'Rate plan ini sudah tidak tersedia di supplier'))
        return
      }
      res.json(success(view))
      return
    }
    case 'retry_later':
      next(unavailable())
      return
    case 'invalid':
      next(new ValidationError(result.reason))
      return
    case 'key_reused':
      next(
        conflict('IDEMPOTENCY_KEY_REUSED', 'Kunci idempotensi sudah dipakai untuk pemesanan lain'),
      )
      return
    case 'refused':
      next(result.error)
      return
    case 'not_found':
      next(new NotFoundError('Pemesanan tidak ditemukan'))
  }
}

function respondToHold(res: Response, next: Next, result: HoldResult): void {
  switch (result.kind) {
    case 'held':
      res.json(success(bookingView(result.booking)))
      return
    case 'sold_out':
      next(conflict('SOLD_OUT', 'Kamar untuk tanggal ini sudah habis'))
      return
    case 'in_progress':
      next(conflict('HOLD_IN_PROGRESS', 'Hold untuk pemesanan ini sedang diproses'))
      return
    case 'price_changed':
      next(conflict('PRICE_CHANGED', 'Harga berubah saat hold; lakukan price check ulang'))
      return
    case 'retry_later':
      next(unavailable())
      return
    case 'refused':
      next(result.error)
      return
    case 'not_found':
      next(new NotFoundError('Pemesanan tidak ditemukan'))
  }
}

function conflict(code: string, message: string): AppError {
  return new AppError({ code, httpStatus: 409, message })
}

function unavailable(): AppError {
  return new AppError({
    code: 'SUPPLIER_UNAVAILABLE',
    httpStatus: 503,
    message: 'Supplier belum dapat dihubungi. Silakan coba lagi.',
  })
}
