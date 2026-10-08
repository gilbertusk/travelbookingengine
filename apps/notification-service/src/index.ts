// Harus paling pertama — lihat catatan pada telemetry.ts.
import { tracingSdk } from './telemetry.js'

import { topicFor } from '@tbe/event-contracts'
import {
  consumerResource,
  createCommandConsumer,
  createEventConsumer,
  createKafkaClient,
  createRabbitConnection,
  mainQueue,
  producerResource,
  toProducerPort,
} from '@tbe/messaging'
import {
  CORRELATION_HEADER,
  createApp,
  createLogger,
  getCorrelationId,
  tracingResource,
  type ManagedResource,
} from '@tbe/shared-kernel'
import { deliverDue } from './application/deliver.js'
import type { NotificationDeps } from './application/ports.js'
import { createNotificationHttpApp, createNotificationMetrics } from './composition/app.js'
import { deliveryLoop } from './composition/delivery-loop.js'
import { loadConfig } from './config.js'
import {
  createHttpBookingDirectory,
  createHttpVoucherDocuments,
  undiciTransport,
} from './infrastructure/http-directories.js'
import { createPrismaClient, prismaResource } from './infrastructure/prisma-client.js'
import { createPrismaNotificationRepository } from './infrastructure/prisma-notification-repository.js'
import { createDeliveryMetrics } from './infrastructure/prom-metrics.js'
import { createSmtpSender, createSmtpTransport } from './infrastructure/smtp-sender.js'
import { systemClock, uuidSource } from './infrastructure/system.js'
import { NOTIFICATION_EVENTS, handleNotificationEvent } from './messaging/booking-events.js'
import { handleSendCommand } from './messaging/send-command.js'

/**
 * Composition root. Satu-satunya tempat wiring terjadi — CONVENTIONS.md bagian 1.
 */

const HOUR_MS = 3_600_000

const config = loadConfig()

const logger = createLogger({
  serviceName: config.SERVICE_NAME,
  level: config.LOG_LEVEL,
  pretty: config.NODE_ENV === 'development',
})

const prisma = createPrismaClient(config.DATABASE_URL)
const kafka = createKafkaClient({ clientId: config.SERVICE_NAME, brokers: [config.KAFKA_BROKERS] })
// Produsen hanya untuk dead letter peristiwa cacat; service ini tidak
// menerbitkan peristiwa apa pun.
const producer = kafka.producer()
const consumer = kafka.consumer({ groupId: config.KAFKA_GROUP_ID })
const rabbit = createRabbitConnection({ url: config.RABBITMQ_URL })

const smtp = createSmtpTransport({
  host: config.SMTP_HOST,
  port: config.SMTP_PORT,
  secure: config.SMTP_SECURE === 'true',
  user: config.SMTP_USER,
  password: config.SMTP_PASSWORD,
  timeoutMs: config.SMTP_TIMEOUT_MS,
})

const transport = undiciTransport(
  config.UPSTREAM_TIMEOUT_MS,
  () => {
    const correlationId = getCorrelationId()
    return correlationId === undefined ? {} : { [CORRELATION_HEADER]: correlationId }
  },
  (url, error) => {
    logger.debug({ err: error, url }, 'service hulu tidak menjawab')
  },
)

const metrics = createNotificationMetrics(config.SERVICE_NAME)

const deps: NotificationDeps = {
  notifications: createPrismaNotificationRepository(prisma, uuidSource),
  bookings: createHttpBookingDirectory(config.BOOKING_SERVICE_URL, transport),
  vouchers: createHttpVoucherDocuments(config.VOUCHER_SERVICE_URL, transport),
  sender: createSmtpSender(smtp.transport, config.MAIL_FROM),
  metrics: createDeliveryMetrics(metrics.registry),
  clock: systemClock,
  policy: {
    ratePerHour: config.RATE_LIMIT_PER_HOUR,
    recipientKeySecret: config.RECIPIENT_KEY_SECRET,
    batchSize: config.DELIVERY_BATCH_SIZE,
    leaseMs: config.DELIVERY_LEASE_MS,
  },
  logger,
}

const delivery = deliveryLoop({
  intervalMs: config.DELIVERY_INTERVAL_MS,
  batchSize: config.DELIVERY_BATCH_SIZE,
  logger,
  tick: async () => await deliverDue(deps),
})

const wake = (): void => {
  delivery.wake()
}

const app = createNotificationHttpApp({ deps, logger, metrics })

let server: ReturnType<typeof app.listen> | undefined

const httpResource: ManagedResource = {
  name: 'http',
  start: async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(config.PORT, () => {
        logger.info({ port: config.PORT }, 'notification service mendengarkan')
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

const commandConsumerResource: ManagedResource = {
  name: 'rabbit-consumers',
  start: async () => {
    rabbit.consume(
      mainQueue('notification.send'),
      config.NOTIFICATION_PREFETCH,
      createCommandConsumer({
        command: 'notification.send',
        publisher: rabbit.publisher,
        logger,
        handle: handleSendCommand(deps, wake),
      }),
    )
    await Promise.resolve()
  },
  stop: async () => {
    await Promise.resolve()
  },
}

const eventTopics = [...new Set(NOTIFICATION_EVENTS.map((event) => topicFor(event).name))]

const managed = createApp({
  serviceName: config.SERVICE_NAME,
  logger,
  // Urutan penutupan adalah kebalikan urutan ini: consumer berhenti lebih
  // dulu, lalu penghantar menyelesaikan putarannya, baru SMTP dan basis data
  // ditutup.
  resources: [
    tracingResource(tracingSdk),
    prismaResource(prisma),
    smtp.resource,
    producerResource(producer),
    rabbit.resource,
    delivery,
    commandConsumerResource,
    consumerResource({
      consumer,
      topics: eventTopics,
      handler: createEventConsumer({
        subscribedTo: NOTIFICATION_EVENTS,
        producer: toProducerPort(producer),
        logger,
        handle: handleNotificationEvent(deps, {
          maxEventAgeMs: config.MAX_EVENT_AGE_HOURS * HOUR_MS,
          wake,
        }),
      }),
    }),
    httpResource,
  ],
})

await managed.start()
