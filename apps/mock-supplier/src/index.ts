import { createApp, createLogger, type ManagedResource } from '@tbe/shared-kernel'
import { loadConfig } from './config.js'
import { buildMockSupplierApp } from './composition/app.js'

/**
 * Composition root. Satu-satunya tempat wiring terjadi — CONVENTIONS.md bagian 1.
 */

const config = loadConfig()

const logger = createLogger({
  serviceName: config.SERVICE_NAME,
  level: config.LOG_LEVEL,
  pretty: config.NODE_ENV === 'development',
})

const { app } = buildMockSupplierApp({ logger, instant: config.MOCK_SUPPLIER_INSTANT })

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, 'mock supplier mendengarkan')
})

const httpResource: ManagedResource = {
  name: 'http',
  stop: async () => {
    await new Promise<void>((resolve, reject) => {
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
  resources: [httpResource],
})

await managed.start()
