import cors from 'cors'
import express, { type Express, type RequestHandler } from 'express'
import helmet from 'helmet'
import type { Logger } from 'pino'
import { pinoHttp } from 'pino-http'
import type { Metrics } from '../observability/metrics.js'
import { metricsHandler } from '../observability/metrics.js'
import { correlationIdOf, correlationMiddleware } from './correlation-middleware.js'
import { createErrorHandler, notFoundHandler } from './error-handler.js'

/**
 * Pabrik server HTTP dengan urutan middleware yang sudah benar.
 *
 * Urutannya penting dan mudah salah: correlation harus paling awal agar log
 * permintaan pun membawanya, dan penangan galat harus paling akhir — setelah
 * seluruh rute terpasang. Karena itu pemasangannya dipisah menjadi dua fungsi.
 */

const DEFAULT_BODY_LIMIT = '256kb'
const HEALTH_PATH_PREFIX = '/health'

export interface HttpServerOptions {
  readonly logger: Logger
  readonly corsOrigins?: readonly string[] | undefined
  readonly bodyLimit?: string | undefined
  /**
   * Bila diberikan, /metrics dipasang otomatis dan durasi setiap permintaan
   * dicatat. Endpoint metrik yang harus didaftarkan manual di setiap service
   * adalah endpoint yang akan terlupa di salah satunya, dan ketiadaannya baru
   * terlihat sebagai grafik kosong berminggu-minggu kemudian.
   */
  readonly metrics?: Metrics | undefined
  /**
   * 'none' mematikan penguraian badan permintaan sepenuhnya.
   *
   * Dibutuhkan gateway: badan yang sudah terurai tidak dapat diteruskan lagi
   * sebagai aliran, dan mengurai lalu menyusun ulangnya berarti gateway
   * memutuskan bentuk data yang sebenarnya bukan urusannya — serta memutus
   * unggahan besar dan Server-Sent Events.
   */
  readonly bodyParser?: 'json' | 'none' | undefined
}

/**
 * Mencatat durasi permintaan dengan label pola rute, bukan path mentah.
 *
 * Path mentah memuat pengenal — /bookings/bkg_123 — dan setiap pemesanan akan
 * menjadi deret waktu tersendiri di Prometheus. Beberapa ribu pemesanan cukup
 * untuk membuat Prometheus tidak dapat dipakai.
 */
function createHttpMetricsMiddleware(metrics: Metrics): RequestHandler {
  return (req, res, next) => {
    const stop = metrics.domain.httpRequestDuration.startTimer()

    res.on('finish', () => {
      const route = `${req.baseUrl}${req.route === undefined ? '(unmatched)' : (req.route as { path: string }).path}`
      stop({ method: req.method, route, status: String(res.statusCode) })
    })

    next()
  }
}

export function createHttpServer(options: HttpServerOptions): Express {
  const app = express()

  app.disable('x-powered-by')
  app.set('trust proxy', true)

  app.use(correlationMiddleware())
  app.use(
    pinoHttp({
      logger: options.logger,
      genReqId: (_req, res) => correlationIdOf(res),
      // Health check dipanggil terus-menerus oleh orkestrator; mencatatnya
      // hanya menenggelamkan log yang berguna.
      autoLogging: {
        ignore: (req) => req.url.startsWith(HEALTH_PATH_PREFIX),
      },
    }),
  )
  app.use(helmet())
  app.use(
    cors({
      origin: options.corsOrigins === undefined ? false : [...options.corsOrigins],
      credentials: true,
    }),
  )
  if (options.bodyParser !== 'none') {
    app.use(express.json({ limit: options.bodyLimit ?? DEFAULT_BODY_LIMIT }))
  }

  if (options.metrics !== undefined) {
    app.get('/metrics', metricsHandler(options.metrics.registry))
    app.use(createHttpMetricsMiddleware(options.metrics))
  }

  return app
}

/**
 * Dipanggil setelah seluruh rute terpasang. Memasang penangan 404 dan penangan
 * galat, yang keduanya harus berada di urutan paling akhir.
 */
export function finalizeHttpServer(app: Express, logger: Logger): Express {
  app.use(notFoundHandler())
  app.use(createErrorHandler(logger))
  return app
}
