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
import type { ResilienceDeps } from '../application/ports.js'
import { createSupplierRouter } from '../http/supplier-routes.js'

/**
 * Perangkaian HTTP.
 *
 * Dipisahkan dari perangkaian dependensi supaya pengujian memakai aplikasi
 * yang sama persis dengan produksi, hanya dengan port yang dipalsukan. Pola
 * yang sama dengan auth-service — aplikasi uji yang dirangkai sendiri akan
 * berbeda dari yang sesungguhnya, dan perbedaannya selalu di tempat yang
 * tidak diduga.
 */

export interface SupplierHttpOptions {
  readonly deps: ResilienceDeps
  readonly logger: Logger
  readonly serviceName: string
  readonly corsOrigins?: readonly string[] | undefined
  readonly extraChecks?: readonly HealthCheck[]
}

export function createSupplierHttpApp(options: SupplierHttpOptions): {
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
      [...(options.extraChecks ?? []), suppliersCheck(options.deps)],
      options.logger,
    ),
  )
  app.use(createSupplierRouter(options.deps))

  finalizeHttpServer(app, options.logger)

  return { app, metrics }
}

/**
 * Kesiapan dilaporkan dari sisi konfigurasi, bukan dari keterjangkauan supplier.
 *
 * Service ini SIAP meski kelima supplier sedang tumbang — justru itulah
 * tugasnya: menangani supplier yang tumbang. Melaporkan tidak siap akan
 * membuat orkestrator membunuh service yang sedang bekerja dengan benar.
 */
function suppliersCheck(deps: ResilienceDeps): HealthCheck {
  return {
    name: 'supplier-directory',
    check: async () => {
      const settings = await deps.directory.list()

      // Direktori kosong berarti tabel belum di-seed; itu masalah konfigurasi
      // yang sungguhan dan layak membuat service dinyatakan belum siap.
      return settings.length > 0
    },
  }
}
