// Harus paling pertama — lihat catatan pada telemetry.ts.
import { tracingSdk } from './telemetry.js'

import {
  consumerResource,
  createCommandConsumer,
  createEventConsumer,
  createEventPublisher,
  createKafkaClient,
  createRabbitConnection,
  mainQueue,
  producerResource,
  toProducerPort,
} from '@tbe/messaging'
import { topicFor } from '@tbe/event-contracts'
import { createApp, createLogger, tracingResource, type ManagedResource } from '@tbe/shared-kernel'
import { Redis } from 'ioredis'
import { createPaymentHttpApp } from './composition/app.js'
import { loadConfig } from './config.js'
import { createKafkaPaymentEvents } from './infrastructure/kafka-payment-events.js'
import { createMidtransGateway } from './infrastructure/midtrans-gateway.js'
import { createPrismaClient, prismaResource } from './infrastructure/prisma-client.js'
import { createPrismaPayableAmounts } from './infrastructure/prisma-payable-amounts.js'
import { createPrismaPaymentRepository } from './infrastructure/prisma-payment-repository.js'
import { createPrismaWebhookLedger } from './infrastructure/prisma-webhook-ledger.js'
import { createRedisWebhookRateLimiter } from './infrastructure/rate-limiters.js'
import { createSignatureVerifier } from './infrastructure/signature-verifier.js'
import { systemClock, uuidFactory } from './infrastructure/system.js'
import { BOOKING_EVENTS, handleBookingEvent } from './messaging/booking-events.js'
import { handleRefund } from './messaging/refund-command.js'
import type { PaymentDeps } from './application/ports.js'

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
const bookingConsumer = kafka.consumer({ groupId: `${config.SERVICE_NAME}.booking` })
const rabbit = createRabbitConnection({ url: config.RABBITMQ_URL })

const deps: PaymentDeps = {
  payments: createPrismaPaymentRepository(prisma),
  ledger: createPrismaWebhookLedger(prisma),
  payables: createPrismaPayableAmounts(prisma),
  gateway: createMidtransGateway({
    snapBaseUrl: config.MIDTRANS_SNAP_BASE_URL,
    apiBaseUrl: config.MIDTRANS_API_BASE_URL,
    // Satu-satunya tempat server key diteruskan, dan tujuannya adalah adapter
    // yang menandatangani. Ia tidak pernah masuk ke PaymentDeps.
    serverKey: config.MIDTRANS_SERVER_KEY,
    logger,
  }),
  events: createKafkaPaymentEvents(createEventPublisher(toProducerPort(producer))),
  verifier: createSignatureVerifier(config.MIDTRANS_SERVER_KEY),
  clock: systemClock,
  ids: uuidFactory,
  logger,
}

const { app } = createPaymentHttpApp({
  deps,
  limiter: createRedisWebhookRateLimiter(redis, {
    points: config.WEBHOOK_RATE_PER_MINUTE,
    durationSeconds: 60,
  }),
  logger,
  serviceName: config.SERVICE_NAME,
  corsOrigins: config.CORS_ORIGINS,
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
        logger.info({ port: config.PORT }, 'payment service mendengarkan')
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

/**
 * Consumer perintah refund.
 *
 * Prefetch 1: refund adalah operasi uang, dan memproses beberapa sekaligus pada
 * satu proses tidak menambah apa pun selain peluang dua perintah untuk
 * pembayaran yang sama berjalan bersamaan. Paralelismenya didapat dari
 * menggandakan instance, bukan dari menaikkan prefetch.
 */
const refundConsumerResource: ManagedResource = {
  name: 'rabbit-consumers',
  start: async () => {
    rabbit.consume(
      mainQueue('payment.refund'),
      1,
      createCommandConsumer({
        command: 'payment.refund',
        publisher: rabbit.publisher,
        logger,
        handle: handleRefund(deps),
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
  // Urutan penutupan adalah kebalikan urutan ini. Consumer berhenti lebih dulu
  // daripada basis data ditutup: perintah refund yang sedang berjalan saat
  // koneksi hilang akan gagal setelah penyedia dihubungi tetapi sebelum hasilnya
  // tercatat, dan itu keadaan yang paling mahal di service ini.
  resources: [
    tracingResource(tracingSdk),
    prismaResource(prisma),
    redisResource,
    producerResource(producer),
    rabbit.resource,
    refundConsumerResource,
    consumerResource({
      consumer: bookingConsumer,
      topics: [topicFor('booking.created').name],
      handler: createEventConsumer({
        subscribedTo: BOOKING_EVENTS,
        producer: toProducerPort(producer),
        logger,
        handle: handleBookingEvent(deps),
      }),
    }),
    httpResource,
  ],
})

await managed.start()
