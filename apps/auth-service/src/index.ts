// Harus paling pertama — lihat catatan pada telemetry.ts.
import { tracingSdk } from './telemetry.js'

import { createApp, createLogger, tracingResource, type ManagedResource } from '@tbe/shared-kernel'
import { buildAuthApp } from './composition/app.js'
import { loadConfig } from './config.js'
import { createPrismaClient, prismaResource } from './infrastructure/prisma-client.js'

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
const { app } = buildAuthApp({ config, logger, prisma })

let server: ReturnType<typeof app.listen> | undefined

const httpResource: ManagedResource = {
  name: 'http',
  start: async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(config.PORT, () => {
        logger.info({ port: config.PORT }, 'auth service mendengarkan')
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
  // Urutan penutupan adalah kebalikan urutan ini: HTTP berhenti menerima
  // permintaan lebih dulu, lalu database ditutup, lalu penelusuran. Menutup
  // database sementara permintaan masih masuk akan menghasilkan sederet galat
  // yang menyesatkan tepat pada saat penutupan.
  resources: [tracingResource(tracingSdk), prismaResource(prisma), httpResource],
})

await managed.start()
