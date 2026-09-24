import { AppError, NotFoundError, success, validate } from '@tbe/shared-kernel'
import { SUPPLIER_CODES, type SupplierCode, type SupplierError } from '@tbe/supplier-adapters'
import { Router, type RequestHandler, type Response } from 'express'
import { z } from 'zod'
import { confirmBooking } from '../application/confirm-booking.js'
import type { ResilienceDeps } from '../application/ports.js'
import { cancel, hold, priceCheck, search } from '../application/supplier-operations.js'

/**
 * Antarmuka internal.
 *
 * Dipakai search-service dan booking-service. Tidak terdaftar di api-gateway —
 * tidak ada rute publik yang menunjuk ke sini, dan itu disengaja: lapisan
 * ketahanan tidak punya apa pun yang perlu dilihat pengguna.
 *
 * Setiap rute punya pabrik handler sendiri; factory router hanya mendaftarkan.
 * Pola yang sama dengan seluruh service lain.
 */

const supplierParam = z.enum(SUPPLIER_CODES)

const stay = z.object({
  checkIn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  checkOut: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
})

const searchBody = validate(
  z
    .object({
      supplier: supplierParam,
      city: z.string().min(2),
      guests: z.number().int().positive().max(10),
    })
    .and(stay),
  'body',
)

const priceCheckBody = validate(
  z.object({ supplier: supplierParam, supplierRatePlanId: z.string().min(1) }).and(stay),
  'body',
)

const holdBody = validate(
  z
    .object({
      supplier: supplierParam,
      supplierRatePlanId: z.string().min(1),
      guests: z.number().int().positive().max(10),
    })
    .and(stay),
  'body',
)

const confirmBody = validate(
  z.object({
    supplier: supplierParam,
    holdRef: z.string().min(1),
    guestName: z.string().min(1),
    idempotencyKey: z.string().min(1).max(200),
  }),
  'body',
)

const cancelBody = validate(
  z.object({ supplier: supplierParam, bookingReference: z.string().min(1) }),
  'body',
)

const settingsBody = validate(
  z.object({
    isActive: z.boolean().optional(),
    circuit: z
      .object({
        failureThreshold: z.number().int().positive().max(100).optional(),
        windowMs: z.number().int().positive().optional(),
        openDurationMs: z.number().int().positive().optional(),
      })
      .optional(),
  }),
  'body',
)

export function createSupplierRouter(deps: ResilienceDeps): Router {
  const router = Router()

  router.post('/internal/suppliers/search', searchBody, searchHandler(deps))
  router.post('/internal/suppliers/price-check', priceCheckBody, priceCheckHandler(deps))
  router.post('/internal/suppliers/hold', holdBody, holdHandler(deps))
  router.post('/internal/suppliers/confirm', confirmBody, confirmHandler(deps))
  router.post('/internal/suppliers/cancel', cancelBody, cancelHandler(deps))

  router.get('/internal/suppliers', listHandler(deps))
  router.patch('/internal/suppliers/:code', settingsBody, updateHandler(deps))

  return router
}

function searchHandler(deps: ResilienceDeps): RequestHandler {
  return (_req, res, next) => {
    const body = searchBody.value(res)

    void search(deps, body.supplier, body, { correlationId: correlation(res) }).then((result) => {
      if (!result.ok) {
        next(toHttpError(result.error))
        return
      }

      res.json(success(result.value))
    }, next)
  }
}

function priceCheckHandler(deps: ResilienceDeps): RequestHandler {
  return (_req, res, next) => {
    const body = priceCheckBody.value(res)

    void priceCheck(deps, body, { correlationId: correlation(res) }).then((result) => {
      if (!result.ok) {
        next(toHttpError(result.error))
        return
      }

      res.json(success(result.value))
    }, next)
  }
}

function holdHandler(deps: ResilienceDeps): RequestHandler {
  return (_req, res, next) => {
    const body = holdBody.value(res)

    void hold(deps, body, { correlationId: correlation(res) }).then((result) => {
      if (!result.ok) {
        next(toHttpError(result.error))
        return
      }

      res.json(success(result.value))
    }, next)
  }
}

/**
 * Konfirmasi pemesanan.
 *
 * Keadaan `uncertain` dibalas 202, bukan 500. Itu bukan kegagalan: permintaan
 * diterima, statusnya belum dapat dipastikan, dan rekonsiliasi yang akan
 * menuntaskannya. Membalas 500 akan membuat pemanggil mencobanya lagi —
 * tepat hal yang seluruh mekanisme ini ada untuk mencegahnya.
 */
function confirmHandler(deps: ResilienceDeps): RequestHandler {
  return (_req, res, next) => {
    const body = confirmBody.value(res)

    void confirmBooking(deps, { ...body, correlationId: correlation(res) }).then((outcome) => {
      if (outcome.status === 'confirmed') {
        res.json(
          success({ status: 'confirmed', adopted: outcome.adopted, booking: outcome.booking }),
        )
        return
      }

      if (outcome.status === 'uncertain') {
        res
          .status(202)
          .json(success({ status: 'uncertain', idempotencyKey: outcome.idempotencyKey }))
        return
      }

      next(toHttpError(outcome.error))
    }, next)
  }
}

function cancelHandler(deps: ResilienceDeps): RequestHandler {
  return (_req, res, next) => {
    const body = cancelBody.value(res)

    void cancel(deps, body.supplier, body.bookingReference, {
      correlationId: correlation(res),
    }).then((result) => {
      if (!result.ok) {
        next(toHttpError(result.error))
        return
      }

      res.json(success({ status: 'cancelled' }))
    }, next)
  }
}

function listHandler(deps: ResilienceDeps): RequestHandler {
  return (_req, res, next) => {
    void deps.directory.list().then((settings) => {
      res.json(success(settings))
    }, next)
  }
}

/**
 * Mengubah konfigurasi supplier — FR-29.
 *
 * Dilindungi peran operator di api-gateway, bukan di sini: rute ini tidak
 * terdaftar sebagai rute publik sama sekali.
 */
function updateHandler(deps: ResilienceDeps): RequestHandler {
  return (req, res, next) => {
    const code = String(req.params.code).toUpperCase()

    if (!isSupplierCode(code)) {
      next(new NotFoundError(`supplier ${code} tidak dikenal`))
      return
    }

    void deps.directory.update(code, settingsBody.value(res)).then((updated) => {
      if (updated === undefined) {
        next(new NotFoundError(`supplier ${code} belum terdaftar`))
        return
      }

      res.json(success(updated))
    }, next)
  }
}

function isSupplierCode(value: string): value is SupplierCode {
  return (SUPPLIER_CODES as readonly string[]).includes(value)
}

function correlation(res: Response): string | undefined {
  const value = (res.locals as Record<string, unknown>).correlationId

  return typeof value === 'string' ? value : undefined
}

/**
 * Jenis kegagalan supplier menjadi status HTTP.
 *
 * Pemetaannya dipilih supaya pemanggil internal dapat mengambil keputusan
 * dari statusnya saja: 503 dan 504 berarti coba lagi nanti, 409 berarti
 * jawaban yang sah, 502 berarti supplier bermasalah dan orang perlu melihat.
 */
export function toHttpError(error: SupplierError): AppError {
  const message = `supplier ${error.supplier} gagal pada ${error.operation}`

  switch (error.kind) {
    case 'timeout':
      return new AppError({ code: 'SUPPLIER_TIMEOUT', httpStatus: 504, message })
    case 'unavailable':
      return new AppError({ code: 'SUPPLIER_UNAVAILABLE', httpStatus: 503, message })
    case 'rate_limited':
      return new AppError({ code: 'SUPPLIER_RATE_LIMITED', httpStatus: 429, message })
    case 'not_found':
      return new NotFoundError(message)
    case 'sold_out':
      return new AppError({ code: 'SOLD_OUT', httpStatus: 409, message })
    case 'price_changed':
      return new AppError({ code: 'PRICE_CHANGED', httpStatus: 409, message })
    case 'hold_expired':
      return new AppError({ code: 'HOLD_EXPIRED', httpStatus: 409, message })
    case 'already_cancelled':
      return new AppError({ code: 'ALREADY_CANCELLED', httpStatus: 409, message })
    case 'invalid_response':
    case 'upstream_error':
      return new AppError({ code: 'SUPPLIER_ERROR', httpStatus: 502, message })
  }
}
