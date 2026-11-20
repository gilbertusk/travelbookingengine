import { requireOperator } from '@tbe/shared-kernel'
import { Router } from 'express'
import type { PaymentDeps } from '../application/ports.js'
import { getPaymentHandler, paymentParams } from './payment-routes.js'

/**
 * Rute panel operator (Step 27): status pembayaran untuk halaman NEEDS_REVIEW.
 *
 * Handler yang SAMA dengan `/internal/payments/:id` — satu bentuk jawaban —
 * tetapi di balik `requireOperator`, karena awalan `/ops` dirutekan gateway
 * dari luar sedangkan `/internal` tidak. Rute pelanggan `/payments` tidak
 * dipakai: ia memeriksa kepemilikan, dan operator bukan pemilik pembayaran
 * yang ia tinjau.
 */
export function createOpsRouter(deps: PaymentDeps): Router {
  const router = Router()

  router.use('/ops/payments', requireOperator)
  router.get('/ops/payments/:id', paymentParams, getPaymentHandler(deps))

  return router
}
