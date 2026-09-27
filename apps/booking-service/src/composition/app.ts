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
import type { BookingDeps } from '../application/ports.js'
import { sweepHolds } from '../application/sweep-holds.js'
import { createBookingRouter } from '../http/booking-routes.js'

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
}

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
  app.use(createBookingRouter(options.deps))

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

/**
 * Penyapu hold sebagai sumber daya terkelola.
 *
 * Putaran berikutnya dijadwalkan SETELAH putaran sebelumnya selesai, bukan
 * dengan `setInterval`. Putaran yang lebih lama dari selangnya — basis data
 * lambat, ribuan hold kedaluwarsa sekaligus setelah pemadaman — tidak boleh
 * bertumpuk dengan putaran berikutnya. Aman bila bertumpuk, karena seluruh
 * perpindahannya idempoten; tetapi tumpukan itu tidak melepaskan apa pun
 * lebih cepat dan hanya menambah beban pada saat yang paling tidak tepat.
 */
export function holdSweeper(deps: BookingDeps, intervalMs: number): ManagedResource {
  let timer: NodeJS.Timeout | undefined
  let running: Promise<void> | undefined
  let stopped = false

  const tick = async (): Promise<void> => {
    try {
      const report = await sweepHolds(deps)
      const released = report.due.expired + report.orphansReleased
      if (released > 0) deps.logger.info(report, 'penyapu hold melepaskan hold')
    } catch (error) {
      // Satu putaran yang gagal tidak menghentikan penyapu. Tingkat error:
      // penyapu adalah jaring pengaman terakhir, dan jaring yang terus gagal
      // berarti hold yatim menumpuk tanpa ada yang melepaskannya.
      deps.logger.error({ err: error }, 'putaran penyapu hold gagal')
    }
    if (!stopped) timer = setTimeout(schedule, intervalMs)
  }

  const schedule = (): void => {
    running = tick()
  }

  return {
    name: 'hold-sweeper',
    start: async () => {
      timer = setTimeout(schedule, intervalMs)
      await Promise.resolve()
    },
    stop: async () => {
      stopped = true
      clearTimeout(timer)
      await running
    },
  }
}
