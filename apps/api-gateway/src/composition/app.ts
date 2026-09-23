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
import type { GatewayDeps } from '../application/ports.js'
import { ROUTES } from '../domain/routes.js'
import { createIdentityMiddleware } from '../http/authenticate.js'
import { createMethodGuard } from '../http/method-guard.js'
import { createProxyHandler } from '../http/proxy.js'
import { createRateLimitMiddleware } from '../http/rate-limit.js'

export interface GatewayAppOptions {
  readonly deps: GatewayDeps
  readonly logger: Logger
  readonly serviceName: string
  readonly corsOrigins?: readonly string[] | undefined
  readonly bodyLimit?: string | undefined
}

/**
 * Perangkaian gateway.
 *
 * Urutan middleware di sini adalah keamanannya, dan tidak boleh diubah tanpa
 * alasan yang ditulis:
 *
 * 1. correlation dan log permintaan — dari shared-kernel, paling awal
 * 2. health dan metrik — sebelum apa pun yang dapat menolak permintaan, supaya
 *    orkestrator tetap dapat membaca keadaan saat sistem sedang membatasi laju
 * 3. penjaga metode — menolak metode aneh sebelum permintaannya diproses
 * 4. identitas — token diverifikasi sebelum kuota dihitung, supaya pembatasan
 *    laju memakai pengguna dan bukan alamat IP bersama
 * 5. pembatasan laju
 * 6. penerusan
 */
export function createGatewayApp(options: GatewayAppOptions): {
  app: Express
  metrics: Metrics
} {
  const metrics = createMetrics({ serviceName: options.serviceName })

  const app = createHttpServer({
    logger: options.logger,
    metrics,
    corsOrigins: options.corsOrigins,
    // Gateway tidak pernah mengurai badan permintaan — ia meneruskannya
    // sebagai aliran. Lihat catatan pada HttpServerOptions.
    bodyParser: 'none',
    ...(options.bodyLimit === undefined ? {} : { bodyLimit: options.bodyLimit }),
  })

  app.use(createHealthRouter(upstreamChecks(options.deps), options.logger))
  app.use(createMethodGuard())
  app.use(createIdentityMiddleware(options.deps.verifier))
  app.use(createRateLimitMiddleware(options.deps.limiter))
  app.use(createProxyHandler(options.deps.upstream))

  finalizeHttpServer(app, options.logger)

  return { app, metrics }
}

/**
 * Health check melaporkan keterjangkauan seluruh service hulu.
 *
 * Gateway yang menyatakan diri siap padahal seluruh hulunya mati akan menerima
 * trafik lalu menolak semuanya dengan 503 — dan dari luar itu terlihat seperti
 * gateway yang rusak, bukan hulu yang mati.
 */
function upstreamChecks(deps: GatewayDeps): readonly HealthCheck[] {
  const services = [...new Set(ROUTES.map((route) => route.service))]

  return services.map((service) => ({
    name: service,
    check: async () => await deps.upstream.probe(service),
  }))
}
