import { moneySchema } from '@tbe/event-contracts'
import { money } from '@tbe/money'
import {
  ConflictError,
  NotFoundError,
  RateLimitedError,
  UnauthorizedError,
  UpstreamError,
  success,
  validate,
} from '@tbe/shared-kernel'
import { Router, type RequestHandler, type Response } from 'express'
import { z } from 'zod'
import {
  createPaymentIntent,
  type CreateIntentResult,
  type IntentRejection,
} from '../application/create-payment-intent.js'
import {
  handleNotification,
  type NotificationHandling,
} from '../application/handle-notification.js'
import type { PaymentDeps, WebhookRateLimiter } from '../application/ports.js'
import { PaymentRejectedError } from '../domain/errors.js'
import type { Payment } from '../domain/payment.js'

/**
 * Antarmuka HTTP.
 *
 * Dua kelompok rute dengan sifat keamanan yang berlawanan, dan itu disengaja:
 *
 * - `/internal/payments` — dipakai booking-service dan api-gateway. Tidak
 *   terdaftar sebagai rute publik.
 * - `/webhooks/midtrans` — dipanggil PENYEDIA, tanpa autentikasi pengguna. Yang
 *   menggantikan autentikasi adalah verifikasi tanda tangan, dan yang
 *   menggantikan pembatas laju gateway adalah pembatas laju di sini. Endpoint
 *   ini tidak melewati api-gateway sama sekali, jadi tidak ada pembatas lain
 *   yang melindunginya.
 */

const intentBody = validate(
  z.object({
    bookingId: z.uuid(),
    idempotencyKey: z.string().min(1).max(200),
    /**
     * Nilai yang DILIHAT pengguna. Dibandingkan dengan harga yang disetujui,
     * tidak ditagih — lihat application/create-payment-intent.ts.
     */
    amount: moneySchema,
  }),
  'body',
)

const paymentParams = validate(z.object({ id: z.uuid() }), 'params')

/**
 * Bentuk notifikasi Midtrans.
 *
 * `looseObject`, bukan `object`: penyedia mengirim jauh lebih banyak bidang
 * daripada yang dipakai di sini, dan bidang yang tidak dikenal harus TETAP ADA
 * pada payload yang dicatat. Skema yang membuang bidang tak dikenal akan membuat
 * catatan webhook_events kehilangan justru bidang yang dicari ketika ada
 * sengketa pembayaran.
 */
const notificationBody = validate(
  z.looseObject({
    order_id: z.string().min(1),
    transaction_id: z.string().min(1),
    transaction_status: z.string().min(1),
    fraud_status: z.string().optional(),
    status_code: z.string().min(1),
    /** String desimal, dipakai MENTAH sebagai bahan tanda tangan. */
    gross_amount: z.string().min(1),
    currency: z.enum(['IDR', 'USD']),
    signature_key: z.string().min(1),
  }),
  'body',
)

export interface PaymentRouterOptions {
  readonly deps: PaymentDeps
  readonly limiter: WebhookRateLimiter
}

export function createPaymentRouter(options: PaymentRouterOptions): Router {
  const router = Router()

  router.post('/internal/payments', intentBody, createIntentHandler(options.deps))
  router.get('/internal/payments/:id', paymentParams, getPaymentHandler(options.deps))
  router.post(
    '/webhooks/midtrans',
    webhookRateLimit(options.limiter),
    notificationBody,
    notificationHandler(options.deps),
  )

  return router
}

function createIntentHandler(deps: PaymentDeps): RequestHandler {
  return async (_req, res, next) => {
    try {
      const body = intentBody.value(res)

      const result = await createPaymentIntent(deps, {
        bookingId: body.bookingId,
        idempotencyKey: body.idempotencyKey,
        amount: money(body.amount.amountMinor, body.amount.currency),
      })

      respondToIntent(res, result, next)
    } catch (error) {
      next(error)
    }
  }
}

function respondToIntent(
  res: Response,
  result: CreateIntentResult,
  next: (error: unknown) => void,
): void {
  if (result.kind === 'created') {
    res.status(201).json(success({ payment: view(result.payment), ...providerLink(result) }))
    return
  }

  if (result.kind === 'resumed') {
    res.json(success({ payment: view(result.payment), ...providerLink(result) }))
    return
  }

  if (result.kind === 'existing') {
    res.json(success({ payment: view(result.payment) }))
    return
  }

  next(intentError(result.why))
}

function intentError(why: IntentRejection): Error {
  if (why === 'amount_not_approved') {
    // 409, bukan 400: permintaannya berbentuk benar, keadaannya yang berubah.
    // Pesannya menyuruh memuat ulang harga, karena itulah yang harus dilakukan.
    return new ConflictError('Harga sudah berubah. Muat ulang harga sebelum membayar.')
  }

  if (why === 'amount_unknown') {
    return new ConflictError('Pemesanan ini belum siap dibayar.')
  }

  if (why === 'gateway_rejected') return new PaymentRejectedError()

  return new UpstreamError({
    upstream: 'midtrans',
    message: 'Penyedia pembayaran sedang tidak dapat dihubungi. Coba lagi sebentar.',
  })
}

function getPaymentHandler(deps: PaymentDeps): RequestHandler {
  return async (_req, res, next) => {
    try {
      const { id } = paymentParams.value(res)
      const payment = await deps.payments.findById(id)

      if (payment === undefined) {
        next(new NotFoundError('Pembayaran tidak ditemukan'))
        return
      }

      res.json(success({ payment: view(payment) }))
    } catch (error) {
      next(error)
    }
  }
}

/**
 * Pembatasan laju endpoint webhook.
 *
 * Dikunci alamat IP. Penyedia memanggil dari sejumlah kecil alamat yang tetap,
 * jadi kunci per alamat cukup — dan tidak ada identitas pengguna yang dapat
 * dipakai, karena tidak ada pengguna di sini.
 */
function webhookRateLimit(limiter: WebhookRateLimiter): RequestHandler {
  return async (req, res, next) => {
    try {
      const decision = await limiter.consume(`webhook:${req.ip ?? 'unknown'}`)

      res.setHeader('ratelimit-limit', String(decision.limit))
      res.setHeader('ratelimit-remaining', String(decision.remaining))

      if (decision.allowed) {
        next()
        return
      }

      res.setHeader('retry-after', String(decision.resetAfterSeconds))
      next(new RateLimitedError('Terlalu banyak notifikasi. Coba lagi sebentar.'))
    } catch (error) {
      next(error)
    }
  }
}

function notificationHandler(deps: PaymentDeps): RequestHandler {
  return async (_req, res, next) => {
    try {
      const body = notificationBody.value(res)

      const result = await handleNotification(deps, {
        orderId: body.order_id,
        transactionId: body.transaction_id,
        transactionStatus: body.transaction_status,
        fraudStatus: body.fraud_status,
        statusCode: body.status_code,
        grossAmount: body.gross_amount,
        currency: body.currency,
        signatureKey: body.signature_key,
        payload: body,
      })

      respondToNotification(res, result, next)
    } catch (error) {
      next(error)
    }
  }
}

/**
 * Pemetaan hasil ke status HTTP.
 *
 * Midtrans MENGIRIM ULANG notifikasi yang tidak dijawab 2xx, dan itu yang
 * membentuk pemetaan di bawah:
 *
 * - Yang sudah selesai atau memang tidak perlu diproses dijawab 200, supaya
 *   penyedia berhenti mengirimnya.
 * - `in_progress` dijawab 409 supaya penyedia MENGIRIMNYA LAGI: klaimnya belum
 *   ditutup, jadi belum ada yang menjamin notifikasi itu selesai diproses.
 * - Tanda tangan tidak sah dijawab 401 dan nilai yang tidak cocok 422. Keduanya
 *   tidak akan berubah dengan dikirim ulang, tetapi keduanya juga tidak boleh
 *   dijawab 200 — jawaban 200 pada notifikasi palsu membuatnya tidak terlihat
 *   di dasbor penyedia.
 */
function respondToNotification(
  res: Response,
  result: NotificationHandling,
  next: (error: unknown) => void,
): void {
  switch (result.kind) {
    case 'applied':
      res.json(success({ outcome: 'applied', status: result.payment.status }))
      return

    case 'duplicate':
      res.json(success({ outcome: 'duplicate', previous: result.outcome }))
      return

    case 'ignored':
      res.json(success({ outcome: 'ignored', why: result.why }))
      return

    case 'in_progress':
      res.status(409).json(success({ outcome: 'in_progress' }))
      return

    case 'rejected':
      next(notificationError(result.why))
  }
}

function notificationError(why: string): Error {
  if (why === 'invalid_signature') {
    // Pesannya sengaja tidak menjelaskan apa yang salah. Penyerang yang
    // mengetahui bahwa tanda tangannya "hampir benar" mendapat informasi.
    return new UnauthorizedError('Notifikasi tidak dapat diverifikasi')
  }

  if (why === 'unknown_payment') return new NotFoundError('Pembayaran tidak ditemukan')

  return new ConflictError('Notifikasi tidak dapat diproses')
}

/**
 * Bentuk pembayaran untuk respons.
 *
 * Disusun eksplisit, bukan mengirim entitasnya. Mengirim entitas berarti setiap
 * bidang baru di domain ikut terbit ke klien tanpa ada yang memutuskannya.
 */
/**
 * Dua cara membuka halaman bayar Snap: tautan untuk mode halaman penuh, token
 * untuk mode popup. Klien yang memilih; keduanya menunjuk transaksi yang sama.
 */
function providerLink(result: { readonly redirectUrl: string; readonly snapToken: string }) {
  return { redirectUrl: result.redirectUrl, snapToken: result.snapToken }
}

function view(payment: Payment): Record<string, unknown> {
  return {
    id: payment.id,
    bookingId: payment.bookingId,
    status: payment.status,
    amount: { amountMinor: payment.amount.amountMinor, currency: payment.amount.currency },
    ...(payment.status === 'FAILED' ? { failureReason: payment.failureReason } : {}),
    ...(payment.status === 'PENDING' || payment.status === 'FAILED'
      ? {}
      : {
          gatewayRef: payment.gatewayRef,
          refunds: payment.refunds.map((refund) => ({
            id: refund.id,
            requestId: refund.requestId,
            status: refund.status,
            reason: refund.reason,
            amount: {
              amountMinor: refund.amount.amountMinor,
              currency: refund.amount.currency,
            },
          })),
        }),
  }
}
