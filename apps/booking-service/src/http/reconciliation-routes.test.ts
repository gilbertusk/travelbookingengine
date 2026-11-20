import { USER_ROLE_HEADER } from '@tbe/shared-kernel'
import request from 'supertest'
import { describe, expect, test } from 'vitest'
import { createBookingHttpApp } from '../composition/app.js'
import type { SupplierCode } from '../domain/booking.js'
import {
  createPrismaReconciliationReports,
  createPrismaReconciliationStore,
} from '../infrastructure/prisma-reconciliation.js'
import { createPrismaReviewReader } from '../infrastructure/prisma-review-reader.js'
import { harness, USER } from '../testing/fakes.js'
import { memoryReconciliationDb } from '../testing/memory-reconciliation.js'
import { USER_ID_HEADER } from './booking-routes.js'

const OPERATOR = {
  [USER_ID_HEADER]: '0c4d2e8f-1a3b-4c5d-9e6f-7a8b9c0d1e2f',
  [USER_ROLE_HEADER]: 'operator',
}
const RUN_ID = '0b5e7a5e-1c2d-4e3f-8a9b-0c1d2e3f4a5b'
const BOOKING_ID = '3f0c8a52-6d1e-4c3b-9a7f-000000000001'

async function setup() {
  const world = harness()
  const reports = memoryReconciliationDb()
  const store = createPrismaReconciliationStore(reports)
  const requested: (SupplierCode | undefined)[] = []

  await store.begin({ id: RUN_ID, day: '2026-10-01' }, new Date('2026-10-01T03:00:00Z'))
  await store.record({
    runId: RUN_ID,
    bookingId: BOOKING_ID,
    supplier: 'SKY',
    localStatus: 'CONFIRMED',
    kind: 'missing_at_supplier',
    detail: 'rekonsiliasi: CONFIRMED di sini, tidak ditemukan di supplier SKY (SKY-BK-1)',
    flagged: true,
    recordedAt: new Date('2026-10-01T03:00:05Z'),
  })
  await store.finish(
    RUN_ID,
    { checked: 4, matched: 3, mismatched: 1, unverified: 0, flagged: 1 },
    new Date('2026-10-01T03:00:09Z'),
  )

  const app = createBookingHttpApp({
    deps: world.deps,
    logger: world.deps.logger,
    serviceName: 'booking-service-test',
    reviews: createPrismaReviewReader(world.db),
    reconciliation: {
      reports: createPrismaReconciliationReports(reports),
      request: async (supplier) => {
        requested.push(supplier)
        return await Promise.resolve('9c1b2a3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d')
      },
    },
  }).app

  return { app, requested }
}

describe('laporan rekonsiliasi di panel operator (Step 28)', () => {
  test('putaran terakhir beserta temuannya', async () => {
    const { app } = await setup()

    const response = await request(app).get('/ops/bookings/reconciliation').set(OPERATOR)

    expect(response.status).toBe(200)
    expect(response.body.data).toEqual([
      {
        id: RUN_ID,
        day: '2026-10-01',
        supplier: null,
        startedAt: '2026-10-01T03:00:00.000Z',
        finishedAt: '2026-10-01T03:00:09.000Z',
        checked: 4,
        matched: 3,
        mismatched: 1,
        unverified: 0,
        flagged: 1,
        findings: [
          {
            bookingId: BOOKING_ID,
            supplier: 'SKY',
            localStatus: 'CONFIRMED',
            kind: 'missing_at_supplier',
            detail: 'rekonsiliasi: CONFIRMED di sini, tidak ditemukan di supplier SKY (SKY-BK-1)',
            flagged: true,
            recordedAt: '2026-10-01T03:00:05.000Z',
          },
        ],
      },
    ])
  })

  test('tidak terbaca sebagai pengenal pemesanan oleh /ops/bookings/:id', async () => {
    const { app } = await setup()

    const response = await request(app).get('/ops/bookings/reconciliation').set(OPERATOR)

    expect(response.status).not.toBe(400)
  })

  test('operator meminta satu putaran sekarang: 202 dengan pengenalnya, lewat antrean', async () => {
    const { app, requested } = await setup()

    const response = await request(app)
      .post('/ops/bookings/reconciliation/run')
      .set(OPERATOR)
      .send({ supplier: 'NOVA' })

    expect(response.status).toBe(202)
    expect(response.body.data).toEqual({ runId: '9c1b2a3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d' })
    expect(requested).toEqual(['NOVA'])
  })

  test('supplier yang tidak dikenal ditolak sebelum perintah dikirim', async () => {
    const { app, requested } = await setup()

    const response = await request(app)
      .post('/ops/bookings/reconciliation/run')
      .set(OPERATOR)
      .send({ supplier: 'ACME' })

    expect(response.status).toBe(400)
    expect(requested).toEqual([])
  })

  test('tanpa identitas 401, pelanggan 403 — untuk laporan maupun pemicu', async () => {
    const { app, requested } = await setup()

    expect((await request(app).get('/ops/bookings/reconciliation')).status).toBe(401)
    const customer = await request(app)
      .post('/ops/bookings/reconciliation/run')
      .set(USER_ID_HEADER, USER)
      .set(USER_ROLE_HEADER, 'customer')
      .send({})
    expect(customer.status).toBe(403)
    expect(requested).toEqual([])
  })
})
