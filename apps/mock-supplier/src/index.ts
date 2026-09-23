// Harus paling pertama: instrumentasi otomatis menambal pustaka pada saat
// dimuat, dan pustaka yang sudah terlanjur dimuat tidak akan ikut
// terinstrumentasi. Impor ESM dijalankan berurutan sebelum satu pun baris
// badan modul, jadi urutan baris inilah yang menentukan.
import { tracingSdk } from './telemetry.js'

import { createApp, createLogger, tracingResource, type ManagedResource } from '@tbe/shared-kernel'
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
  // Penelusuran ditutup paling akhir — urutan penutupan adalah kebalikan
  // urutan daftar — supaya span dari penutupan sumber daya lain sempat
  // terkirim sebelum eksportirnya ikut mati.
  resources: [tracingResource(tracingSdk), httpResource],
})

await managed.start()
