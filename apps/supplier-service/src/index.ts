// Harus paling pertama — lihat catatan pada telemetry.ts.
import { tracingSdk } from './telemetry.js'

import {
  createApp,
  createLogger,
  createMetrics,
  tracingResource,
  type ManagedResource,
} from '@tbe/shared-kernel'
import {
  createCommandConsumer,
  createEventPublisher,
  createKafkaClient,
  createRabbitConnection,
  mainQueue,
  producerResource,
  toProducerPort,
} from '@tbe/messaging'
import { createSupplierRegistry, mockSupplierRegistryConfig } from '@tbe/supplier-adapters'
import { Redis } from 'ioredis'
import { createSupplierHttpApp } from './composition/app.js'
import { loadConfig } from './config.js'
import {
  createKafkaConfirmReplies,
  createKafkaSupplierEvents,
} from './infrastructure/kafka-events.js'
import { createPrismaClient, prismaResource } from './infrastructure/prisma-client.js'
import { createPrismaDirectory } from './infrastructure/prisma-directory.js'
import { createPrismaRequestLog } from './infrastructure/prisma-request-log.js'
import { createSupplierMetrics } from './infrastructure/prom-metrics.js'
import { createRedisCircuitStore } from './infrastructure/redis-circuit-store.js'
import { createRedisRateLimiter } from './infrastructure/redis-rate-limiter.js'
import { systemClock, systemSleeper } from './infrastructure/system.js'
import {
  handleCancel,
  handleConfirm,
  handleConfirmDeadLetter,
} from './messaging/command-handlers.js'
import type { ResilienceDeps } from './application/ports.js'

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
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null })

const kafka = createKafkaClient({ clientId: config.SERVICE_NAME, brokers: [config.KAFKA_BROKERS] })
const producer = kafka.producer()
const rabbit = createRabbitConnection({ url: config.RABBITMQ_URL })

const registry = createSupplierRegistry(mockSupplierRegistryConfig(config.SUPPLIER_BASE_URL))

/**
 * Registry metrik dibuat LEBIH DULU dan diberikan ke dependensi maupun ke
 * aplikasi HTTP — satu registry, jadi metrik lapisan ketahanan muncul di
 * `/metrics`.
 *
 * Versi sebelumnya membaca `metrics` dari hasil `createSupplierHttpApp` lewat
 * fungsi "tertunda" yang ternyata dipanggil SEBELUM hasil itu ada: `buildDeps()`
 * adalah argumen pemanggilan yang sama. Proses mati saat startup dengan
 * ReferenceError — dan tidak ada yang tahu, karena `index.ts` tidak pernah
 * dijalankan sampai uji integrasi Step 20.
 */
const metrics = createMetrics({ serviceName: config.SERVICE_NAME })

const { app } = createSupplierHttpApp({
  deps: buildDeps(),
  logger,
  serviceName: config.SERVICE_NAME,
  corsOrigins: config.CORS_ORIGINS,
  metrics,
})

function buildDeps(): ResilienceDeps {
  const bucket = {
    refillPerSecond: config.SUPPLIER_RATE_PER_SECOND,
    capacity: config.SUPPLIER_RATE_BURST,
  }

  return {
    registry,
    circuits: createRedisCircuitStore(redis),
    rateLimiter: createRedisRateLimiter(redis, {
      SKY: bucket,
      NOVA: bucket,
      ORBIT: bucket,
      LUNA: bucket,
      ZEPH: bucket,
    }),
    requestLog: createPrismaRequestLog(prisma, (error) => {
      // Catatan yang gagal ditulis tidak boleh menggagalkan pemesanan yang
      // sudah berhasil. Dicatat sebagai galat, lalu dilanjutkan.
      logger.error({ error }, 'gagal mencatat permintaan supplier')
    }),
    events: createKafkaSupplierEvents(createEventPublisher(toProducerPort(producer))),
    metrics: createSupplierMetrics(metrics),
    directory: createPrismaDirectory(prisma),
    clock: systemClock,
    sleeper: systemSleeper,
    random: Math.random,
  }
}

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
        logger.info({ port: config.PORT }, 'supplier service mendengarkan')
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

const consumersResource: ManagedResource = {
  name: 'rabbit-consumers',
  start: async () => {
    const deps = {
      resilience: buildDeps(),
      logger,
      // Jawaban konfirmasi untuk saga booking-service (Step 19).
      replies: createKafkaConfirmReplies(createEventPublisher(toProducerPort(producer))),
    }

    rabbit.consume(
      mainQueue('supplier.confirm'),
      1,
      createCommandConsumer({
        command: 'supplier.confirm',
        publisher: rabbit.publisher,
        logger,
        handle: handleConfirm(deps),
        onDeadLetter: handleConfirmDeadLetter(deps),
      }),
    )

    rabbit.consume(
      mainQueue('supplier.cancel'),
      4,
      createCommandConsumer({
        command: 'supplier.cancel',
        publisher: rabbit.publisher,
        logger,
        handle: handleCancel(deps),
      }),
    )

    await Promise.resolve()
  },
  stop: async () => {
    await Promise.resolve()
  },
}

const managed = createApp({
  serviceName: config.SERVICE_NAME,
  logger,
  // Urutan penutupan adalah kebalikan urutan ini. Consumer berhenti lebih
  // dulu daripada database ditutup: perintah yang sedang diproses saat
  // koneksi database hilang akan gagal di tengah jalan, dan `book` yang gagal
  // di tengah jalan adalah persis keadaan yang paling mahal.
  resources: [
    tracingResource(tracingSdk),
    prismaResource(prisma),
    redisResource,
    producerResource(producer),
    rabbit.resource,
    consumersResource,
    httpResource,
  ],
})

await managed.start()
