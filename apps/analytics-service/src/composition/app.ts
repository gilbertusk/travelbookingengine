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
import type { AnalyticsStore, Clock } from '../application/ports.js'
import { createOpsRouter } from '../http/ops-routes.js'

/**
 * Perangkaian HTTP analytics-service. Pintu masuk bisnisnya Kafka; HTTP hanya
 * health check, /metrics, dan laporan untuk panel operator.
 */

export interface AnalyticsHttpOptions {
  readonly store: AnalyticsStore
  readonly clock: Clock
  readonly logger: Logger
  readonly serviceName: string
  readonly summaryDefaultDays: number
}

export function createAnalyticsHttpApp(options: AnalyticsHttpOptions): {
  app: Express
  metrics: Metrics
} {
  const metrics = createMetrics({ serviceName: options.serviceName })
  const app = createHttpServer({ logger: options.logger, metrics })

  app.use(createHealthRouter([databaseCheck(options.store)], options.logger))
  app.use(
    createOpsRouter({
      store: options.store,
      clock: options.clock,
      defaultDays: options.summaryDefaultDays,
    }),
  )

  finalizeHttpServer(app, options.logger)

  return { app, metrics }
}

/**
 * Kesiapan hanya bergantung pada basis data. Kafka yang tersendat TIDAK
 * membuat service ini tidak siap: laporan tetap dapat dibaca, hanya
 * tertinggal — dan tertinggal adalah keadaan normal sebuah konsumen analitik.
 */
function databaseCheck(store: AnalyticsStore): HealthCheck {
  return {
    name: 'database',
    check: async () => {
      await store.processedCount()
      return true
    },
  }
}
