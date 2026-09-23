import cors from 'cors'
import express, { type Express } from 'express'
import helmet from 'helmet'
import type { Logger } from 'pino'
import { pinoHttp } from 'pino-http'
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
  app.use(express.json({ limit: options.bodyLimit ?? DEFAULT_BODY_LIMIT }))

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
