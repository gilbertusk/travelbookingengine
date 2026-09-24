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
import type { PricingDeps } from '../application/ports.js'
import { createPricingRouter } from '../http/pricing-routes.js'

/**
 * Perangkaian HTTP, dipisahkan dari perangkaian dependensi supaya pengujian
 * memakai aplikasi yang sama persis dengan produksi.
 */
export interface PricingHttpOptions {
  readonly deps: PricingDeps
  readonly logger: Logger
  readonly serviceName: string
  readonly corsOrigins?: readonly string[] | undefined
  readonly extraChecks?: readonly HealthCheck[]
}

export function createPricingHttpApp(options: PricingHttpOptions): {
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
    createHealthRouter([...(options.extraChecks ?? []), ratesCheck(options.deps)], options.logger),
  )
  app.use(createPricingRouter(options.deps))

  finalizeHttpServer(app, options.logger)

  return { app, metrics }
}

/**
 * Kesiapan bergantung pada adanya kurs.
 *
 * Service ini TIDAK siap tanpa kurs: setiap harga supplier dalam dolar akan
 * gagal dihitung, dan gagal diam-diam untuk sebagian hasil jauh lebih buruk
 * daripada menyatakan diri belum siap.
 */
function ratesCheck(deps: PricingDeps): HealthCheck {
  return {
    name: 'exchange-rates',
    check: async () => (await deps.rates.current()).length > 0,
  }
}
