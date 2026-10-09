import request from 'supertest'
import { describe, expect, test } from 'vitest'
import { world } from '../testing/fakes.js'
import { createNotificationHttpApp, createNotificationMetrics } from './app.js'

function app(w = world()) {
  return createNotificationHttpApp({
    deps: w.deps,
    logger: w.deps.logger,
    metrics: createNotificationMetrics('notification-service-test'),
  })
}

describe('HTTP notification-service', () => {
  test('siap selama basis data menjawab, walau SMTP dan booking-service mati', async () => {
    const w = world()
    w.sender.throwing = true
    w.bookings.failing = true

    const response = await request(app(w)).get('/health/ready')

    expect(response.status).toBe(200)
  })

  test('tidak siap bila basis data tidak menjawab', async () => {
    const w = world()
    w.notifications.sentToRecipientSince = async () => await Promise.reject(new Error('mati'))

    const response = await request(app(w)).get('/health/ready')

    expect(response.status).toBe(503)
  })

  test('tidak ada rute bisnis', async () => {
    expect((await request(app()).get('/notifications')).status).toBe(404)
  })
})
