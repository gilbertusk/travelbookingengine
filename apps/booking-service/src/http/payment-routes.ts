import { AppError, NotFoundError, success } from '@tbe/shared-kernel'
import { Router, type RequestHandler, type Response } from 'express'
import type { BookingDeps, Payments } from '../application/ports.js'
import { startPayment, type StartPaymentResult } from '../application/start-payment.js'
import { bookingParams } from './booking-routes.js'
import { identity } from './identity.js'
import { bookingView } from './views.js'

/**
 * `POST /bookings/:id/payment` — pintu pengguna ke pembayaran (Step 21).
 *
 * Lewat api-gateway di awalan /bookings yang sudah mewajibkan autentikasi.
 * Jawabannya membawa dua cara membuka Snap: token untuk popup dan tautan untuk
 * halaman penuh. Keberhasilan pembayaran TIDAK diputuskan di sini maupun di
 * klien — kebenarannya notifikasi penyedia ke payment-service.
 */
export function createPaymentRouter(deps: BookingDeps, payments: Payments): Router {
  const router = Router()

  router.post('/bookings/:id/payment', identity, bookingParams, paymentHandler(deps, payments))

  return router
}

function paymentHandler(deps: BookingDeps, payments: Payments): RequestHandler {
  return (_req, res, next) => {
    const request = { userId: identity.value(res), bookingId: bookingParams.value(res).id }

    void startPayment(deps, payments, request).then((result) => {
      respond(res, next, result, deps.clock.now())
    }, next)
  }
}

function respond(
  res: Response,
  next: (error?: unknown) => void,
  result: StartPaymentResult,
  now: Date,
): void {
  switch (result.kind) {
    case 'started':
      res.json(
        success({
          paymentId: result.paymentId,
          redirectUrl: result.redirectUrl,
          snapToken: result.snapToken,
          booking: bookingView(result.booking, now),
        }),
      )
      return
    case 'already_paid':
      next(conflict('ALREADY_PAID', 'Pembayaran untuk pemesanan ini sudah diterima'))
      return
    case 'not_payable':
      next(conflict('NOT_PAYABLE', 'Pemesanan ini belum atau tidak lagi dapat dibayar'))
      return
    case 'hold_expired':
      next(conflict('HOLD_EXPIRED', 'Waktu penahanan kamar sudah habis'))
      return
    case 'retry_later':
      next(
        new AppError({
          code: 'PAYMENT_UNAVAILABLE',
          httpStatus: 503,
          message: 'Pembayaran belum dapat dibuka. Silakan coba lagi sebentar.',
        }),
      )
      return
    case 'rejected':
      next(
        new AppError({
          code: 'PAYMENT_REJECTED',
          httpStatus: 402,
          message: 'Penyedia pembayaran menolak transaksi ini.',
        }),
      )
      return
    case 'not_found':
      next(new NotFoundError('Pemesanan tidak ditemukan'))
  }
}

function conflict(code: string, message: string): AppError {
  return new AppError({ code, httpStatus: 409, message })
}
