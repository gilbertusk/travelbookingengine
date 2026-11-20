// Harus paling pertama — lihat catatan pada telemetry.ts.
import { tracingSdk } from './telemetry.js'

import { createKafkaClient } from '@tbe/messaging'
import { createApp, createLogger, tracingResource, type ManagedResource } from '@tbe/shared-kernel'
import type { AnalyticsDeps } from './application/ports.js'
import { createAnalyticsHttpApp } from './composition/app.js'
import { analyticsConsumer } from './composition/consumer.js'
import { loadConfig } from './config.js'
import { createPrismaAnalyticsStore } from './infrastructure/prisma-analytics-store.js'
import { createPrismaClient, prismaResource } from './infrastructure/prisma-client.js'
import { systemClock } from './infrastructure/system.js'

/**
 * Composition root. Satu-satunya tempat wiring terjadi — CONVENTIONS.md bagian 1.
 *
 * Tidak ada produsen Kafka di sini, dan itu disengaja: analitik hanya membaca.
 */

const config = loadConfig()

const logger = createLogger({
  serviceName: config.SERVICE_NAME,
  level: config.LOG_LEVEL,
  pretty: config.NODE_ENV === 'development',
})

const prisma = createPrismaClient(config.DATABASE_URL)
const kafka = createKafkaClient({ clientId: config.SERVICE_NAME, brokers: [config.KAFKA_BROKERS] })
const store = createPrismaAnalyticsStore(prisma)
const deps: AnalyticsDeps = { store, clock: systemClock, logger }

const { app } = createAnalyticsHttpApp({
  store,
  clock: systemClock,
  logger,
  serviceName: config.SERVICE_NAME,
  summaryDefaultDays: config.SUMMARY_DEFAULT_DAYS,
})

let server: ReturnType<typeof app.listen> | undefined

const httpResource: ManagedResource = {
  name: 'http',
  start: async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(config.PORT, () => {
        logger.info({ port: config.PORT }, 'analytics service mendengarkan')
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
  // Penutupan kebalikan urutan ini: consumer berhenti lebih dulu, baru basis
  // data ditutup — pesan yang sedang dicatat sempat selesai.
  resources: [
    tracingResource(tracingSdk),
    prismaResource(prisma),
    analyticsConsumer({ kafka, groupId: config.KAFKA_GROUP_ID, deps, logger }),
    httpResource,
  ],
})

await managed.start()
