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
import { topicFor } from '@tbe/event-contracts'
import {
  consumerResource,
  createCommandSender,
  createEventConsumer,
  createEventPublisher,
  createKafkaClient,
  createRabbitConnection,
  producerResource,
  toProducerPort,
} from '@tbe/messaging'
import { Redis } from 'ioredis'
import { expireHold } from './application/expire-hold.js'
import type { BookingDeps } from './application/ports.js'
import {
  createBookingHttpApp,
  holdSweeper,
  outboxPublisher,
  sagaSweeper,
} from './composition/app.js'
import { loadConfig } from './config.js'
import {
  createHttpPayments,
  createHttpPricing,
  createHttpSupplierQuotes,
  undiciTransport,
} from './infrastructure/http-gateways.js'
import { expiryListener } from './infrastructure/keyspace-expiry.js'
import { createOutboxRelay } from './infrastructure/outbox-relay.js'
import { createMessagingTransport } from './infrastructure/outbox-transport.js'
import { createPrismaBookingRepository } from './infrastructure/prisma-booking-repository.js'
import { createPrismaSagaStore } from './infrastructure/prisma-saga-store.js'
import { bookingDbOf, createPrismaClient, prismaResource } from './infrastructure/prisma-client.js'
import { createRedisHoldStore } from './infrastructure/redis-hold-store.js'
import { systemClock, uuidFactory } from './infrastructure/system.js'
import { SAGA_EVENTS, handleSagaEvent } from './messaging/saga-events.js'

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
const db = bookingDbOf(prisma)
const redisOptions = { db: config.REDIS_DB, maxRetriesPerRequest: null }
const redis = new Redis(config.REDIS_URL, redisOptions)
// Koneksi kedua: koneksi dalam mode subscribe tidak dapat menjalankan skrip hold.
const subscriber = new Redis(config.REDIS_URL, redisOptions)

const transport = undiciTransport(config.UPSTREAM_TIMEOUT_MS, () => {
  const correlationId = getCorrelationId()
  return correlationId === undefined ? {} : { [CORRELATION_HEADER]: correlationId }
})

const kafka = createKafkaClient({
  clientId: config.SERVICE_NAME,
  brokers: config.KAFKA_BROKERS.split(','),
})
// Produser idempoten: percobaan ulang KafkaJS setelah jawaban broker hilang
// tidak menulis pesan dua kali, dan urutan per partisi tetap. Outbox
// menjamin minimal sekali; ini mengurangi seberapa sering "lebih dari
// sekali" benar-benar terjadi.
const producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1 })
const consumer = kafka.consumer({ groupId: config.KAFKA_CONSUMER_GROUP })
const rabbit = createRabbitConnection({ url: config.RABBITMQ_URL })

const deps: BookingDeps = {
  bookings: createPrismaBookingRepository(db),
  sagas: createPrismaSagaStore(db),
  sagaPolicy: {
    leaseMs: config.SAGA_STEP_LEASE_MS,
    confirmTimeoutMs: config.SAGA_CONFIRM_TIMEOUT_MS,
    awaitRefundTimeoutMs: config.SAGA_REFUND_TIMEOUT_MS,
    compensationRetry: {
      maxAttempts: config.SAGA_COMPENSATION_MAX_ATTEMPTS,
      retryDelayMs: config.SAGA_COMPENSATION_RETRY_MS,
    },
    sweepBatch: config.SAGA_SWEEP_BATCH,
  },
  suppliers: createHttpSupplierQuotes(config.SUPPLIER_SERVICE_URL, transport),
  pricing: createHttpPricing(config.PRICING_SERVICE_URL, transport),
  holds: createRedisHoldStore(redis),
  clock: systemClock,
  ids: uuidFactory,
  holdPolicy: { durationMs: config.HOLD_DURATION_MS, sweepBatch: config.HOLD_SWEEP_BATCH },
  logger,
}

const { app } = createBookingHttpApp({
  deps,
  payments: createHttpPayments(config.PAYMENT_SERVICE_URL, transport),
  logger,
  serviceName: config.SERVICE_NAME,
  statusStream: {
    pollMs: config.STATUS_STREAM_POLL_MS,
    heartbeatMs: config.STATUS_STREAM_HEARTBEAT_MS,
  },
})

const onSagaEvent = handleSagaEvent(deps)

const relay = createOutboxRelay(
  db,
  createMessagingTransport(
    createEventPublisher(toProducerPort(producer)),
    createCommandSender(rabbit.publisher),
  ),
  {
    batch: config.OUTBOX_BATCH,
    transactionTimeoutMs: config.OUTBOX_TX_TIMEOUT_MS,
    now: () => systemClock.now(),
    logger,
  },
)

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
  // consumer berhenti membaca, pendengar dan penyapu berhenti, penerbit
  // outbox menyelesaikan batch-nya, baru koneksi ditutup. Penyapu yang
  // sedang memindahkan pemesanan saat koneksi hilang meninggalkan kursi yang
  // tertahan — yang akan dilepas putaran penyapu berikutnya, tetapi baru
  // setelah proses hidup lagi.
  //
  // Urutan PENYALAAN juga disengaja (Step 19): penyapu saga menjalankan
  // putaran pertamanya — pemulihan saga yang tertinggal — sebelum consumer
  // membaca peristiwa baru dan sebelum HTTP menerima hold baru.
  resources: [
    tracingResource(tracingSdk),
    prismaResource(prisma),
    redisResource,
    producerResource(producer),
    rabbit.resource,
    sagaSweeper(deps, config.SAGA_SWEEP_INTERVAL_MS),
    outboxPublisher(relay, {
      intervalMs: config.OUTBOX_POLL_INTERVAL_MS,
      batch: config.OUTBOX_BATCH,
      logger,
    }),
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
    consumerResource({
      consumer,
      topics: [topicFor('payment.succeeded').name, topicFor('supplier.booking_confirmed').name],
      handler: createEventConsumer({
        subscribedTo: SAGA_EVENTS,
        producer: toProducerPort(producer),
        logger,
        handle: async (message) => {
          await onSagaEvent(message)
        },
      }),
    }),
    httpResource,
  ],
})

await managed.start()
