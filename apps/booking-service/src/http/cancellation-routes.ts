import { money, moneySchema } from '@tbe/money'
import { AppError, NotFoundError, success, validate } from '@tbe/shared-kernel'
import { Router, type RequestHandler, type Response } from 'express'
import { z } from 'zod'
import {
  previewCancellation,
  requestCancellation,
  type CancellationResult,
  type PreviewResult,
} from '../application/cancellation/request.js'
import type { NotCancellableReason } from '../application/cancellation/assess.js'
import type { BookingDeps } from '../application/ports.js'
import { bookingParams } from './booking-routes.js'
import {
  cancellablePreviewView,
  notCancellableMessage,
  notCancellableView,
  quoteView,
} from './cancellation-views.js'
import { identity } from './identity.js'
import { bookingView } from './views.js'

/**
 * Pembatalan oleh pengguna (Step 25, FR-27).
 *
 * - `GET /bookings/:id/cancellation-preview` — berapa yang kembali bila
 *   dibatalkan sekarang, tanpa mengubah apa pun. Pemesanan yang tidak dapat
 *   dibatalkan tetap dijawab 200 dengan alasannya: pratinjau adalah
 *   pertanyaan, dan "tidak dapat" adalah jawaban yang sah.
 * - `POST /bookings/:id/cancel` — membatalkan. Badan permintaan WAJIB membawa
 *   nilai pengembalian yang dilihat pengguna di pratinjau. Bila jenjangnya
 *   sudah berganti, jawabannya 409 dengan pratinjau yang baru, dan tidak ada
 *   yang dibatalkan.
 *
 * Pembatalan dijawab 202: yang diterima adalah permintaannya. Kamar dilepas di
 * supplier dan uang dikembalikan sesudahnya, dan klien mengikutinya lewat
 * status pemesanan.
 */

const cancelBody = validate(z.object({ expectedRefund: moneySchema }), 'body')

export function createCancellationRouter(deps: BookingDeps): Router {
  const router = Router()

  router.get('/bookings/:id/cancellation-preview', identity, bookingParams, previewHandler(deps))
  router.post('/bookings/:id/cancel', identity, bookingParams, cancelBody, cancelHandler(deps))

  return router
}

type Next = (error?: unknown) => void

function previewHandler(deps: BookingDeps): RequestHandler {
  return (_req, res, next) => {
    const bookingId = bookingParams.value(res).id
    const request = { userId: identity.value(res), bookingId }

    void previewCancellation(deps, request).then((result) => {
      respondToPreview(res, next, result, { bookingId, now: deps.clock.now() })
    }, next)
  }
}

function respondToPreview(
  res: Response,
  next: Next,
  result: PreviewResult,
  { bookingId, now }: { readonly bookingId: string; readonly now: Date },
): void {
  switch (result.kind) {
    case 'quoted':
      res.json(success(cancellablePreviewView(result.booking, result.quote, now)))
      return
    case 'not_cancellable':
      res.json(success(notCancellableView(bookingId, result.reason, now)))
      return
    case 'retry_later':
      next(unavailable())
      return
    case 'not_found':
      next(new NotFoundError('Pemesanan tidak ditemukan'))
  }
}

function cancelHandler(deps: BookingDeps): RequestHandler {
  return (_req, res, next) => {
    const { amountMinor, currency } = cancelBody.value(res).expectedRefund
    const request = {
      userId: identity.value(res),
      bookingId: bookingParams.value(res).id,
      expectedRefund: money(amountMinor, currency),
    }

    void requestCancellation(deps, request).then((result) => {
      respondToCancel(res, next, result, deps.clock.now())
    }, next)
  }
}

function respondToCancel(res: Response, next: Next, result: CancellationResult, now: Date): void {
  switch (result.kind) {
    case 'accepted':
      res.status(202).json(success(bookingView(result.booking, now)))
      return
    case 'quote_changed':
      next(
        new AppError({
          code: 'REFUND_CHANGED',
          httpStatus: 409,
          message:
            'Nilai pengembalian sudah berubah sejak pratinjau. Periksa nilai yang baru sebelum membatalkan.',
          details: { quote: quoteView(result.quote) },
        }),
      )
      return
    case 'not_cancellable':
      next(notCancellable(result.reason))
      return
    case 'retry_later':
      next(unavailable())
      return
    case 'not_found':
      next(new NotFoundError('Pemesanan tidak ditemukan'))
  }
}

function notCancellable(reason: NotCancellableReason): AppError {
  return new AppError({
    code: 'NOT_CANCELLABLE',
    httpStatus: 409,
    message: notCancellableMessage(reason),
    details: { reason },
  })
}

function unavailable(): AppError {
  return new AppError({
    code: 'CATALOG_UNAVAILABLE',
    httpStatus: 503,
    message: 'Tenggat pembatalan belum dapat dihitung. Silakan coba lagi sebentar.',
  })
}
