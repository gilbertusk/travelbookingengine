// Harus paling pertama — lihat catatan pada telemetry.ts.
import { tracingSdk } from './telemetry.js'

import { createApp, createLogger, tracingResource, type ManagedResource } from '@tbe/shared-kernel'
import { Redis } from 'ioredis'
import { v7 as uuidv7 } from 'uuid'
import { createSearchHttpApp } from './composition/app.js'
import { createSnapshotHolder } from './composition/snapshot-holder.js'
import { loadConfig } from './config.js'
import { createSightingBuffer } from './application/resolve-properties.js'
import { flushSightings } from './application/catalog-refresh.js'
import { createPrismaClient, prismaResource } from './infrastructure/prisma-client.js'
import {
  createPrismaCatalogSource,
  createPrismaMappingStore,
  createPrismaPropertyStore,
  createPrismaUnmappedQueue,
} from './infrastructure/prisma-catalog.js'
import { createRedisSnapshotStore, invalidateCatalog } from './infrastructure/redis-catalog.js'
import {
  createRedisSuggestionCache,
  invalidateSuggestions,
} from './infrastructure/redis-suggestions.js'

/** Composition root. Satu-satunya tempat wiring terjadi. */

const config = loadConfig()

const logger = createLogger({
  serviceName: config.SERVICE_NAME,
  level: config.LOG_LEVEL,
  pretty: config.NODE_ENV === 'development',
})

const prisma = createPrismaClient(config.DATABASE_URL)
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null })

const snapshots = createRedisSnapshotStore(redis, {
  ttlSeconds: config.CATALOG_CACHE_TTL_SECONDS,
  onCacheError: (error) => {
    logger.warn({ error }, 'katalog tidak dapat dibaca dari cache, memakai basis data')
  },
})

const source = createPrismaCatalogSource(prisma, (id) => {
  logger.error({ propertyId: id }, 'properti tidak lolos skema, dilewati saat memuat katalog')
})

const holder = createSnapshotHolder({
  snapshots,
  source,
  now: () => Date.now(),
  onError: (error) => {
    logger.error({ error }, 'katalog gagal disegarkan')
  },
})

const deps = {
  snapshots,
  properties: createPrismaPropertyStore(prisma),
  mappings: createPrismaMappingStore(prisma),
  unmapped: createPrismaUnmappedQueue(prisma),
  suggestions: createRedisSuggestionCache(redis, {
    ttlSeconds: config.SUGGESTION_CACHE_TTL_SECONDS,
    onCacheError: (error) => {
      logger.warn({ error }, 'cache saran tidak dapat dibaca, memakai basis data')
    },
  }),
}

/**
 * Penyangga kemunculan properti belum terpetakan.
 *
 * Milik proses, bukan milik permintaan: pencatatan tidak pernah ditunggu
 * permintaan pencarian. Disiram berkala oleh sumber daya di bawah.
 */
const sightings = createSightingBuffer()

const { app } = createSearchHttpApp({
  deps,
  holder,
  logger,
  serviceName: config.SERVICE_NAME,
  corsOrigins: config.CORS_ORIGINS,
  newId: () => uuidv7(),
  onCatalogChanged: async () => {
    // Pemetaan yang baru dibuat operator harus langsung terlihat. Tanpa ini,
    // ia baru berlaku setelah TTL habis — dan operator yang tidak melihat
    // perubahannya akan memetakannya lagi.
    await invalidateCatalog(redis)
    await invalidateSuggestions(redis)
    await holder.refresh()
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

/**
 * Katalog dimuat SEBELUM service menyatakan diri siap.
 *
 * Service yang menerima trafik tanpa katalog akan menjawab setiap pencarian
 * dengan properti yang seluruhnya belum terpetakan — jawaban yang terlihat
 * berfungsi dan tidak memicu satu pun peringatan.
 */
const catalogResource: ManagedResource = {
  name: 'catalog',
  start: async () => {
    const result = await holder.refresh()
    if (result === 'failed') throw new Error('katalog tidak dapat dimuat saat startup')

    logger.info({ source: result }, 'katalog termuat')
  },
  stop: async () => {
    await Promise.resolve()
  },
}

function everySeconds(
  name: string,
  seconds: number,
  task: () => Promise<unknown>,
): ManagedResource {
  let timer: NodeJS.Timeout | undefined

  return {
    name,
    start: async () => {
      timer = setInterval(() => {
        void task().catch((error: unknown) => {
          logger.error({ error }, `denyut ${name} gagal`)
        })
      }, seconds * 1_000)
      // Tidak menahan proses tetap hidup saat mematikan.
      timer.unref()
      await Promise.resolve()
    },
    stop: async () => {
      if (timer !== undefined) clearInterval(timer)
      // Siram sisa terakhir supaya kemunculan yang tertumpuk tidak hilang
      // bersama proses yang dimatikan.
      await task()
    },
  }
}

let server: ReturnType<typeof app.listen> | undefined

const httpResource: ManagedResource = {
  name: 'http',
  start: async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(config.PORT, () => {
        logger.info({ port: config.PORT }, 'search service mendengarkan')
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
  resources: [
    tracingResource(tracingSdk),
    prismaResource(prisma),
    redisResource,
    catalogResource,
    everySeconds('penyegaran katalog', config.CATALOG_REFRESH_SECONDS, async () => {
      await holder.refresh()
    }),
    everySeconds('pencatatan belum terpetakan', config.UNMAPPED_FLUSH_SECONDS, async () => {
      await flushSightings(sightings, deps.unmapped, (error) => {
        logger.warn({ error }, 'kemunculan properti belum terpetakan gagal dicatat')
      })
    }),
    httpResource,
  ],
})

await managed.start()
