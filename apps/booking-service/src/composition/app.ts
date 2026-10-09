import {
  createHealthRouter,
  createHttpServer,
  createMetrics,
  finalizeHttpServer,
  type HealthCheck,
  type Logger,
  type ManagedResource,
  type Metrics,
} from '@tbe/shared-kernel'
import type { Express } from 'express'
import type { BookingDeps, Payments } from '../application/ports.js'
import { sweepCancellations } from '../application/cancellation/sweep.js'
import { sweepSagas } from '../application/saga/sweep-sagas.js'
import { sweepHolds } from '../application/sweep-holds.js'
import { createBookingRouter } from '../http/booking-routes.js'
import { createCancellationRouter } from '../http/cancellation-routes.js'
import { databaseBusyHandler } from '../http/busy.js'
import { createInternalRouter } from '../http/internal-routes.js'
import { createPaymentRouter } from '../http/payment-routes.js'
import { createStatusRouter, type StatusStreamOptions } from '../http/status-routes.js'
import type { OutboxRelay } from '../infrastructure/outbox-relay.js'
import { periodicResource } from './periodic.js'

/**
 * Perangkaian HTTP, dipisahkan dari perangkaian dependensi supaya pengujian
 * memakai aplikasi yang SAMA PERSIS dengan produksi — pola yang sama dengan
 * payment-service. Hanya port-nya yang dipalsukan.
 */

export interface BookingHttpOptions {
  readonly deps: BookingDeps
  readonly logger: Logger
  readonly serviceName: string
  readonly extraChecks?: readonly HealthCheck[]
  readonly statusStream?: StatusStreamOptions
  /**
   * payment-service. Tanpa ini rute pembayaran tidak dipasang — uji yang
   * hanya menyentuh price check dan hold tidak perlu merangkainya. index.ts
   * SELALU memberikannya.
   */
  readonly payments?: Payments
}

/** Satu pembacaan per detik; komentar penjaga tiap lima belas detik. */
const DEFAULT_STATUS_STREAM: StatusStreamOptions = { pollMs: 1_000, heartbeatMs: 15_000 }

/** UUID nol; health check menyentuh basis data tanpa membaca data sungguhan. */
const PROBE_ID = '00000000-0000-0000-0000-000000000000'

export function createBookingHttpApp(options: BookingHttpOptions): {
  app: Express
  metrics: Metrics
} {
  const metrics = createMetrics({ serviceName: options.serviceName })
  const app = createHttpServer({ logger: options.logger, metrics })

  app.use(
    createHealthRouter(
      [...(options.extraChecks ?? []), databaseCheck(options.deps)],
      options.logger,
    ),
  )
  app.use(createStatusRouter(options.deps, options.statusStream ?? DEFAULT_STATUS_STREAM))
  app.use(createBookingRouter(options.deps))
  app.use(createCancellationRouter(options.deps))
  app.use(createInternalRouter(options.deps))
  if (options.payments !== undefined) {
    app.use(createPaymentRouter(options.deps, options.payments))
  }

  app.use(databaseBusyHandler(options.logger))
  finalizeHttpServer(app, options.logger)

  return { app, metrics }
}

function databaseCheck(deps: BookingDeps): HealthCheck {
  return {
    name: 'database',
    check: async () => {
      await deps.bookings.findById(PROBE_ID)
      return true
    },
  }
}

/** Penyapu hold Step 17: jaring pengaman untuk keyspace notification. */
export function holdSweeper(deps: BookingDeps, intervalMs: number): ManagedResource {
  return periodicResource({
    name: 'hold-sweeper',
    intervalMs,
    logger: deps.logger,
    failure: 'putaran penyapu hold gagal',
    tick: async () => {
      const report = await sweepHolds(deps)
      const released = report.due.expired + report.orphansReleased
      if (released > 0) deps.logger.info(report, 'penyapu hold melepaskan hold')
      return false
    },
  })
}

/**
 * Penyapu saga Step 19: batas waktu dan pemulihan. Putaran pertamanya berjalan
 * di dalam `start` — "saat startup, pulihkan saga yang tertinggal" — sebelum
 * consumer dan HTTP dinyalakan.
 */
export function sagaSweeper(deps: BookingDeps, intervalMs: number): ManagedResource {
  return periodicResource({
    name: 'saga-sweeper',
    intervalMs,
    logger: deps.logger,
    failure: 'putaran penyapu saga gagal',
    runOnStart: true,
    tick: async () => {
      const report = await sweepSagas(deps)
      if (report.timedOut + report.recovered + report.failed > 0) {
        deps.logger.info(report, 'penyapu saga menangani saga')
      }
      // Saga kedua, batas waktu yang sama (Step 25).
      const cancellations = await sweepCancellations(deps)
      if (cancellations.reviewed + cancellations.skipped > 0) {
        deps.logger.info(cancellations, 'penyapu saga menangani pembatalan')
      }
      return false
    },
  })
}

/**
 * Penerbit outbox Step 19. Batch yang penuh berarti masih ada antrean: putaran
 * berikutnya segera, bukan setelah selang.
 */
export function outboxPublisher(
  relay: OutboxRelay,
  options: { readonly intervalMs: number; readonly batch: number; readonly logger: Logger },
): ManagedResource {
  return periodicResource({
    name: 'outbox-publisher',
    intervalMs: options.intervalMs,
    logger: options.logger,
    failure: 'putaran penerbit outbox gagal',
    tick: async () => {
      const report = await relay.relayOnce()
      return !report.stalled && report.published + report.rejected >= options.batch
    },
  })
}
