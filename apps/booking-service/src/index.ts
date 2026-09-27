// Harus paling pertama — lihat catatan pada telemetry.ts.
import { tracingSdk } from './telemetry.js'

import {
  CORRELATION_HEADER,
  createApp,
  createLogger,
  getCorrelationId,
  tracingResource,
  type ManagedResource,
} from '@tbe/shared-kernel'
import { Redis } from 'ioredis'
import { expireHold } from './application/expire-hold.js'
import type { BookingDeps } from './application/ports.js'
import { createBookingHttpApp, holdSweeper } from './composition/app.js'
import { loadConfig } from './config.js'
import {
  createHttpPricing,
  createHttpSupplierQuotes,
  undiciTransport,
} from './infrastructure/http-gateways.js'
import { expiryListener } from './infrastructure/keyspace-expiry.js'
import { createPrismaBookingRepository } from './infrastructure/prisma-booking-repository.js'
import { bookingDbOf, createPrismaClient, prismaResource } from './infrastructure/prisma-client.js'
import { createRedisHoldStore } from './infrastructure/redis-hold-store.js'
import { systemClock, uuidFactory } from './infrastructure/system.js'

/**
 * Composition root. Satu-satunya tempat wiring terjadi — CONVENTIONS.md bagian 1.
 */

const config = loadConfig()

const logger = createLogger({
  serviceName: config.SERVICE_NAME,
  level: config.LOG_LEVEL,
  pretty: config.NODE_ENV === 'development',
})

const prisma = createPrismaClient(config.DATABASE_URL)
const redisOptions = { db: config.REDIS_DB, maxRetriesPerRequest: null }
const redis = new Redis(config.REDIS_URL, redisOptions)
// Koneksi kedua: koneksi dalam mode subscribe tidak dapat menjalankan skrip hold.
const subscriber = new Redis(config.REDIS_URL, redisOptions)

const transport = undiciTransport(config.UPSTREAM_TIMEOUT_MS, () => {
  const correlationId = getCorrelationId()
  return correlationId === undefined ? {} : { [CORRELATION_HEADER]: correlationId }
})

const deps: BookingDeps = {
  bookings: createPrismaBookingRepository(bookingDbOf(prisma)),
  suppliers: createHttpSupplierQuotes(config.SUPPLIER_SERVICE_URL, transport),
  pricing: createHttpPricing(config.PRICING_SERVICE_URL, transport),
  holds: createRedisHoldStore(redis),
  clock: systemClock,
  ids: uuidFactory,
  holdPolicy: { durationMs: config.HOLD_DURATION_MS, sweepBatch: config.HOLD_SWEEP_BATCH },
  logger,
}

const { app } = createBookingHttpApp({ deps, logger, serviceName: config.SERVICE_NAME })

const redisResource: ManagedResource = {
  name: 'redis',
  start: async () => {
    await redis.ping()
  },
  stop: async () => {
    await redis.quit()
    await subscriber.quit()
  },
}

let server: ReturnType<typeof app.listen> | undefined

const httpResource: ManagedResource = {
  name: 'http',
  start: async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(config.PORT, () => {
        logger.info({ port: config.PORT }, 'booking service mendengarkan')
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
  // Urutan penutupan adalah kebalikan urutan ini: HTTP berhenti menerima,
  // lalu pendengar dan penyapu berhenti, baru koneksi ditutup. Penyapu yang
  // sedang memindahkan pemesanan saat koneksi hilang meninggalkan kursi yang
  // tertahan — yang akan dilepas putaran penyapu berikutnya, tetapi baru
  // setelah proses hidup lagi.
  resources: [
    tracingResource(tracingSdk),
    prismaResource(prisma),
    redisResource,
    expiryListener({
      subscriber,
      commands: redis,
      database: config.REDIS_DB,
      logger,
      onExpired: async (bookingId) => {
        const outcome = await expireHold(deps, bookingId)
        logger.debug({ bookingId, outcome }, 'kedaluwarsa hold lewat keyspace')
      },
    }),
    holdSweeper(deps, config.HOLD_SWEEP_INTERVAL_MS),
    httpResource,
  ],
})

await managed.start()
