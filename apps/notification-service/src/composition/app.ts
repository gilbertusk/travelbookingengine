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
import type { NotificationDeps } from '../application/ports.js'

/**
 * Perangkaian HTTP. Service ini tidak punya rute bisnis — pintu masuknya
 * Kafka dan RabbitMQ — jadi HTTP hanya melayani health check dan /metrics.
 */

export interface NotificationHttpOptions {
  readonly deps: NotificationDeps
  readonly logger: Logger
  readonly metrics: Metrics
}

/** Kunci yang tidak pernah dimiliki penerima mana pun; menyentuh basis data tanpa membaca data. */
const PROBE_KEY = 'health-probe'

export function createNotificationMetrics(serviceName: string): Metrics {
  return createMetrics({ serviceName })
}

export function createNotificationHttpApp(options: NotificationHttpOptions): Express {
  const app = createHttpServer({ logger: options.logger, metrics: options.metrics })

  app.use(createHealthRouter([databaseCheck(options.deps)], options.logger))

  finalizeHttpServer(app, options.logger)

  return app
}

/**
 * Kesiapan HANYA bergantung pada basis data, tempat pemberitahuan dicatat.
 * Server SMTP, booking-service, dan voucher-service yang tersendat tidak
 * membuat service ini tidak siap: pemberitahuan tetap tercatat dan menunggu
 * dikirim, dan itu memang mekanismenya.
 */
function databaseCheck(deps: NotificationDeps): HealthCheck {
  return {
    name: 'database',
    check: async () => {
      await deps.notifications.sentToRecipientSince(PROBE_KEY, deps.clock.now())
      return true
    },
  }
}
