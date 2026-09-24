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
import { createCatalogRouter } from '../http/catalog-routes.js'
import type { CatalogDeps } from '../application/ports.js'
import type { SnapshotHolder } from './snapshot-holder.js'

/**
 * Perangkaian HTTP, dipisahkan dari perangkaian dependensi supaya pengujian
 * memakai aplikasi yang sama persis dengan produksi.
 */
export interface SearchHttpOptions {
  readonly deps: CatalogDeps
  readonly holder: SnapshotHolder
  readonly logger: Logger
  readonly serviceName: string
  readonly newId: () => string
  readonly onCatalogChanged: () => Promise<void>
  readonly corsOrigins?: readonly string[] | undefined
  readonly extraChecks?: readonly HealthCheck[]
}

export function createSearchHttpApp(options: SearchHttpOptions): {
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
      [...(options.extraChecks ?? []), catalogCheck(options.holder)],
      options.logger,
    ),
  )

  app.use(
    createCatalogRouter({
      deps: options.deps,
      snapshot: () => options.holder.current(),
      newId: options.newId,
      onCatalogChanged: options.onCatalogChanged,
    }),
  )

  finalizeHttpServer(app, options.logger)

  return { app, metrics }
}

/**
 * Kesiapan bergantung pada katalog yang sudah termuat.
 *
 * Tanpa katalog, setiap properti dari setiap supplier tampil sebagai belum
 * terpetakan. Hasilnya secara teknis benar, terlihat berfungsi, dan seluruhnya
 * salah: satu hotel muncul lima kali tanpa satu pun URL yang dapat dibuka,
 * dan pengguna tidak dapat membandingkan harga — yang merupakan seluruh
 * alasan produk ini ada.
 *
 * Menyatakan diri belum siap jauh lebih baik daripada melayani hasil seperti
 * itu, karena hasil seperti itu tidak akan memicu satu pun peringatan.
 */
function catalogCheck(holder: SnapshotHolder): HealthCheck {
  return {
    name: 'catalog',
    check: async () => await Promise.resolve(holder.current() !== undefined),
  }
}
