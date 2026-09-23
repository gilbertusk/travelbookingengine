// Harus paling pertama — lihat catatan pada telemetry.ts.
import { tracingSdk } from './telemetry.js'

import { createApp, createLogger, tracingResource, type ManagedResource } from '@tbe/shared-kernel'
import { Redis } from 'ioredis'
import { createGatewayApp } from './composition/app.js'
import { loadConfig } from './config.js'
import { createJoseVerifier } from './infrastructure/jose-verifier.js'
import { createRedisRateLimiter } from './infrastructure/rate-limiters.js'
import { createUndiciUpstream } from './infrastructure/undici-upstream.js'

/**
 * Composition root. Satu-satunya tempat wiring terjadi — CONVENTIONS.md bagian 1.
 */

const config = loadConfig()

const logger = createLogger({
  serviceName: config.SERVICE_NAME,
  level: config.LOG_LEVEL,
  pretty: config.NODE_ENV === 'development',
})

const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true })

const { app } = createGatewayApp({
  serviceName: config.SERVICE_NAME,
  logger,
  corsOrigins: config.CORS_ORIGINS,
  bodyLimit: config.BODY_LIMIT,
  deps: {
    verifier: createJoseVerifier({
      secret: config.JWT_SECRET,
      issuer: config.JWT_ISSUER,
      audience: config.JWT_AUDIENCE,
    }),
    limiter: createRedisRateLimiter(redis),
    upstream: createUndiciUpstream({
      auth: config.AUTH_SERVICE_URL,
      search: config.SEARCH_SERVICE_URL,
      pricing: config.PRICING_SERVICE_URL,
      booking: config.BOOKING_SERVICE_URL,
      payment: config.PAYMENT_SERVICE_URL,
      voucher: config.VOUCHER_SERVICE_URL,
      analytics: config.ANALYTICS_SERVICE_URL,
    }),
  },
})

const redisResource: ManagedResource = {
  name: 'redis',
  start: async () => {
    await redis.connect()
  },
  stop: async () => {
    await redis.quit()
  },
}

let server: ReturnType<typeof app.listen> | undefined

const httpResource: ManagedResource = {
  name: 'http',
  start: async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(config.PORT, () => {
        logger.info({ port: config.PORT }, 'api gateway mendengarkan')
        resolve()
      })
    })
  },
  stop: async () => {
    await new Promise<void>((resolve, reject) => {
      if (server === undefined) {
        resolve()
        return
      }

      server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    })
  },
}

const managed = createApp({
  serviceName: config.SERVICE_NAME,
  logger,
  resources: [tracingResource(tracingSdk), redisResource, httpResource],
})

await managed.start()
