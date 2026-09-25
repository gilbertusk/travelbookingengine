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
import type { PaymentDeps, WebhookRateLimiter } from '../application/ports.js'
import { createPaymentRouter } from '../http/payment-routes.js'

/**
 * Perangkaian HTTP.
 *
 * Dipisahkan dari perangkaian dependensi supaya pengujian memakai aplikasi yang
 * SAMA PERSIS dengan produksi, hanya dengan port yang dipalsukan. Pola yang sama
 * dengan auth-service dan supplier-service — aplikasi uji yang dirangkai sendiri
 * akan berbeda dari yang sesungguhnya, dan perbedaannya selalu di tempat yang
 * tidak diduga: urutan middleware.
 */

export interface PaymentHttpOptions {
  readonly deps: PaymentDeps
  readonly limiter: WebhookRateLimiter
  readonly logger: Logger
  readonly serviceName: string
  readonly corsOrigins?: readonly string[] | undefined
  readonly extraChecks?: readonly HealthCheck[]
}

/** UUID nol; dipakai health check untuk menyentuh basis data tanpa membaca data. */
const PROBE_ID = '00000000-0000-0000-0000-000000000000'

export function createPaymentHttpApp(options: PaymentHttpOptions): {
  app: Express
  metrics: Metrics
} {
  const metrics = createMetrics({ serviceName: options.serviceName })

  const app = createHttpServer({
    logger: options.logger,
    metrics,
    corsOrigins: options.corsOrigins,
  })

  app.use(
    createHealthRouter(
      [...(options.extraChecks ?? []), databaseCheck(options.deps)],
      options.logger,
    ),
  )
  app.use(createPaymentRouter({ deps: options.deps, limiter: options.limiter }))

  finalizeHttpServer(app, options.logger)

  return { app, metrics }
}

/**
 * Kesiapan bergantung pada basis data, dan hanya pada itu.
 *
 * Service ini SIAP meski Midtrans sedang tumbang — notifikasi yang tertahan akan
 * dikirim ulang penyedia, dan itu memang mekanismenya. Yang tidak dapat
 * ditoleransi adalah basis data yang tidak dapat dihubungi: tanpa buku besar
 * webhook, tidak ada idempotensi, dan notifikasi yang datang berulang akan
 * diproses berulang.
 */
function databaseCheck(deps: PaymentDeps): HealthCheck {
  return {
    name: 'database',
    check: async () => {
      await deps.payments.findById(PROBE_ID)

      return true
    },
  }
}
