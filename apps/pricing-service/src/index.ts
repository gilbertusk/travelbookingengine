// Harus paling pertama — lihat catatan pada telemetry.ts.
import { tracingSdk } from './telemetry.js'

import { createApp, createLogger, tracingResource, type ManagedResource } from '@tbe/shared-kernel'
import { Redis } from 'ioredis'
import { createPricingHttpApp } from './composition/app.js'
import { loadConfig } from './config.js'
import { withRateCache } from './infrastructure/cached-rates.js'
import { createPrismaClient, prismaResource } from './infrastructure/prisma-client.js'
import {
  createPrismaMarkupRuleStore,
  createPrismaRateProvider,
} from './infrastructure/prisma-stores.js'
import { createTaxPolicyProvider } from './infrastructure/tax-policies.js'

/** Composition root. Satu-satunya tempat wiring terjadi. */

const config = loadConfig()

const logger = createLogger({
  serviceName: config.SERVICE_NAME,
  level: config.LOG_LEVEL,
  pretty: config.NODE_ENV === 'development',
})

const prisma = createPrismaClient(config.DATABASE_URL)
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null })

const { app } = createPricingHttpApp({
  serviceName: config.SERVICE_NAME,
  logger,
  corsOrigins: config.CORS_ORIGINS,
  deps: {
    rates: withRateCache(createPrismaRateProvider(prisma), redis, {
      ttlSeconds: config.RATE_CACHE_TTL_SECONDS,
      onCacheError: (error) => {
        // Cache yang tumbang jatuh kembali ke basis data. Harga yang tidak
        // terhitung jauh lebih mahal daripada pencarian yang sedikit lambat.
        logger.warn({ error }, 'cache kurs tidak dapat dibaca, memakai basis data')
      },
    }),
    markupRules: createPrismaMarkupRuleStore(prisma, (id) => {
      logger.error({ ruleId: id }, 'aturan markup tidak lolos skema, dilewati')
    }),
    taxes: createTaxPolicyProvider({
      name: config.DEFAULT_TAX_NAME,
      basisPoints: config.DEFAULT_TAX_BASIS_POINTS,
    }),
    settings: {
      sellingCurrency: config.SELLING_CURRENCY,
      rounding: config.PRICE_ROUNDING,
    },
  },
})

const redisResource: ManagedResource = {
  name: 'redis',
  start: async () => {
    await redis.ping()
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
        logger.info({ port: config.PORT }, 'pricing service mendengarkan')
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
  resources: [tracingResource(tracingSdk), prismaResource(prisma), redisResource, httpResource],
})

await managed.start()
