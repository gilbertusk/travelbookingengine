// Harus paling pertama — lihat catatan pada telemetry.ts.
import { tracingSdk } from './telemetry.js'

import {
  createCommandConsumer,
  createEventPublisher,
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
import type { VoucherDeps } from './application/ports.js'
import { createVoucherHttpApp, createVoucherMetrics } from './composition/app.js'
import { loadConfig } from './config.js'
import {
  createHttpBookingDirectory,
  createHttpPropertyDirectory,
  undiciTransport,
} from './infrastructure/http-directories.js'
import { createKafkaVoucherEvents } from './infrastructure/kafka-voucher-events.js'
import { createMinioStorage } from './infrastructure/minio-storage.js'
import { createPdfKitRenderer } from './infrastructure/pdfkit-renderer.js'
import { createPrismaClient, prismaResource } from './infrastructure/prisma-client.js'
import { createPrismaVoucherRepository } from './infrastructure/prisma-voucher-repository.js'
import { createIssueMetrics } from './infrastructure/prom-metrics.js'
import { secureTokens, systemClock, uuidFactory } from './infrastructure/system.js'
import { handleGenerate } from './messaging/generate-command.js'

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
const kafka = createKafkaClient({ clientId: config.SERVICE_NAME, brokers: [config.KAFKA_BROKERS] })
const producer = kafka.producer()
const rabbit = createRabbitConnection({ url: config.RABBITMQ_URL })

const storage = createMinioStorage({
  internalUrl: config.MINIO_URL,
  publicUrl: config.MINIO_PUBLIC_URL ?? config.MINIO_URL,
  accessKey: config.MINIO_ACCESS_KEY,
  secretKey: config.MINIO_SECRET_KEY,
  bucket: config.MINIO_BUCKET,
})

const transport = undiciTransport(config.UPSTREAM_TIMEOUT_MS, () => {
  const correlationId = getCorrelationId()
  return correlationId === undefined ? {} : { [CORRELATION_HEADER]: correlationId }
})

const metrics = createVoucherMetrics(config.SERVICE_NAME)

const deps: VoucherDeps = {
  bookings: createHttpBookingDirectory(config.BOOKING_SERVICE_URL, transport),
  properties: createHttpPropertyDirectory(config.SEARCH_SERVICE_URL, transport),
  vouchers: createPrismaVoucherRepository(prisma),
  storage,
  renderer: createPdfKitRenderer(),
  events: createKafkaVoucherEvents(createEventPublisher(toProducerPort(producer))),
  metrics: createIssueMetrics(metrics.registry),
  clock: systemClock,
  ids: uuidFactory,
  tokens: secureTokens,
  logger,
}

const app = createVoucherHttpApp({ deps, logger, metrics })

let server: ReturnType<typeof app.listen> | undefined

const httpResource: ManagedResource = {
  name: 'http',
  start: async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(config.PORT, () => {
        logger.info({ port: config.PORT }, 'voucher service mendengarkan')
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

const generateConsumerResource: ManagedResource = {
  name: 'rabbit-consumers',
  start: async () => {
    rabbit.consume(
      mainQueue('voucher.generate'),
      config.VOUCHER_PREFETCH,
      createCommandConsumer({
        command: 'voucher.generate',
        publisher: rabbit.publisher,
        logger,
        handle: handleGenerate(deps),
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
  // Urutan penutupan adalah kebalikan urutan ini: consumer berhenti sebelum
  // basis data, MinIO, dan produsen Kafka yang dipakainya ditutup.
  resources: [
    tracingResource(tracingSdk),
    prismaResource(prisma),
    storage.resource,
    producerResource(producer),
    rabbit.resource,
    generateConsumerResource,
    httpResource,
  ],
})

await managed.start()
