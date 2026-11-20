import { USER_ID_HEADER, USER_ROLE_HEADER, ValidationError } from '@tbe/shared-kernel'
import request from 'supertest'
import { describe, expect, test } from 'vitest'
import { createAnalyticsHttpApp } from '../composition/app.js'
import { NOW, memoryStore, silentLogger } from '../testing/fakes.js'
import { rangeOf } from './ops-routes.js'

const OPERATOR = { [USER_ID_HEADER]: 'user-ops', [USER_ROLE_HEADER]: 'operator' }

function app(store = memoryStore()) {
  return createAnalyticsHttpApp({
    store,
    clock: { now: () => NOW },
    logger: silentLogger(),
    serviceName: 'analytics-test',
    summaryDefaultDays: 30,
  }).app
}

describe('GET /ops/analytics/summary', () => {
  test('tanpa identitas 401, pelanggan 403', async () => {
    expect((await request(app()).get('/ops/analytics/summary')).status).toBe(401)
    const customer = await request(app())
      .get('/ops/analytics/summary')
      .set(USER_ID_HEADER, 'user-1')
      .set(USER_ROLE_HEADER, 'customer')
    expect(customer.status).toBe(403)
  })

  test('rentang bawaan: 30 hari terakhir sampai hari ini, dengan laporan dari penghitung', async () => {
    const store = memoryStore()
    await store.record(
      {
        eventId: 'e-1',
        eventType: 'search.performed',
        increments: [{ day: '2026-10-25', metric: 'funnel.search', dimension: '', by: 3 }],
      },
      NOW,
    )

    const response = await request(app(store)).get('/ops/analytics/summary').set(OPERATOR)

    expect(response.status).toBe(200)
    expect(response.body.data.range).toEqual({ from: '2026-09-26', to: '2026-10-25' })
    expect(response.body.data.summary.funnel[0]).toEqual({
      stage: 'search',
      count: 3,
      fromPreviousBasisPoints: null,
    })
  })

  test('rentang tidak sah dijawab 400', async () => {
    for (const query of [
      'from=2026-10-10&to=2026-10-01',
      'from=2026-02-30',
      'top=0',
      'to=kemarin',
    ]) {
      const response = await request(app()).get(`/ops/analytics/summary?${query}`).set(OPERATOR)
      expect(response.status).toBe(400)
    }
  })

  test('health: siap bila basis data menjawab', async () => {
    expect((await request(app()).get('/health/ready')).status).toBe(200)
  })
})

describe('rangeOf', () => {
  test('satu hari sah, satu tahun sah, lebih dari setahun ditolak', () => {
    expect(rangeOf({ from: '2026-10-25', to: '2026-10-25' }, NOW, 30)).toEqual({
      from: '2026-10-25',
      to: '2026-10-25',
    })
    expect(rangeOf({ from: '2025-10-25', to: '2026-10-25' }, NOW, 30)).toEqual({
      from: '2025-10-25',
      to: '2026-10-25',
    })
    expect(rangeOf({ from: '2025-10-24', to: '2026-10-25' }, NOW, 30)).toBeInstanceOf(
      ValidationError,
    )
  })

  test('`to` tanpa `from`: rentang bawaan dihitung mundur dari `to`', () => {
    expect(rangeOf({ to: '2026-03-01' }, NOW, 3)).toEqual({ from: '2026-02-27', to: '2026-03-01' })
  })
})
