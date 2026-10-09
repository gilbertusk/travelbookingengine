import {
  createHealthRouter,
  createHttpServer,
  createMetrics,
  finalizeHttpServer,
  type HealthCheck,
  type Logger,
  type Metrics,
} from '@tbe/shared-kernel'
import type { Express } from 'express'
import type { VoucherDeps } from '../application/ports.js'
import { createVoucherRouter } from '../http/voucher-routes.js'

/**
 * Perangkaian HTTP, dipisahkan dari perangkaian dependensi supaya uji memakai
 * aplikasi yang SAMA PERSIS dengan produksi — hanya port-nya yang dipalsukan.
 *
 * Metrik dibuat di sini dan dikembalikan, karena histogram M7 harus terdaftar
 * di registri yang sama dengan yang dibaca `/metrics`.
 */

export interface VoucherHttpOptions {
  readonly deps: VoucherDeps
  readonly logger: Logger
  readonly metrics: Metrics
  readonly extraChecks?: readonly HealthCheck[]
}

/** UUID nol; health check menyentuh basis data tanpa membaca data sungguhan. */
const PROBE_ID = '00000000-0000-0000-0000-000000000000'

export function createVoucherMetrics(serviceName: string): Metrics {
  return createMetrics({ serviceName })
}

export function createVoucherHttpApp(options: VoucherHttpOptions): Express {
  const app = createHttpServer({ logger: options.logger, metrics: options.metrics })

  app.use(
    createHealthRouter(
      [...(options.extraChecks ?? []), databaseCheck(options.deps)],
      options.logger,
    ),
  )
  app.use(createVoucherRouter(options.deps))

  finalizeHttpServer(app, options.logger)

  return app
}

/**
 * Kesiapan bergantung pada basis data. booking-service dan MinIO yang
 * tersendat tidak membuat service ini tidak siap: perintah yang gagal
 * menunggu di antrian tunda, dan itu memang mekanismenya.
 */
function databaseCheck(deps: VoucherDeps): HealthCheck {
  return {
    name: 'database',
    check: async () => {
      await deps.vouchers.findByBookingId(PROBE_ID)
      return true
    },
  }
}
