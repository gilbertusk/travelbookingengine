import {
  createHttpServer,
  createLogger,
  createMetrics,
  finalizeHttpServer,
} from '@tbe/shared-kernel'
import request from 'supertest'
import { describe, expect, test } from 'vitest'
import { databaseBusyHandler } from './busy.js'

const logger = createLogger({ serviceName: 'booking-service-test', level: 'silent' })

function appThrowing(error: unknown) {
  const app = createHttpServer({ logger, metrics: createMetrics({ serviceName: 'busy-test' }) })
  app.get('/x', () => {
    throw error
  })
  app.use(databaseBusyHandler(logger))
  return finalizeHttpServer(app, logger)
}

describe('basis data penuh', () => {
  test.each(['P2028', 'P2024'])('%s dijawab 503 DATABASE_BUSY dengan Retry-After', async (code) => {
    const error = Object.assign(new Error('Unable to start a transaction in the given time.'), {
      code,
    })

    const response = await request(appThrowing(error)).get('/x')

    expect(response.status).toBe(503)
    expect(response.body.error.code).toBe('DATABASE_BUSY')
    expect(response.headers['retry-after']).toBe('1')
    // Pesan Prisma tidak bocor ke klien (NFR-15).
    expect(JSON.stringify(response.body)).not.toContain('transaction')
  })

  test('galat lain diteruskan apa adanya', async () => {
    const response = await request(appThrowing(new Error('rusak'))).get('/x')

    expect(response.status).toBe(500)
  })
})
