import { USER_ROLE_HEADER } from '@tbe/shared-kernel'
import request from 'supertest'
import { describe, expect, test } from 'vitest'
import { startPriceCheck } from '../application/price-check.js'
import { createBookingHttpApp } from '../composition/app.js'
import { createPrismaReviewReader } from '../infrastructure/prisma-review-reader.js'
import { USER, priceCheckRequest } from '../testing/fakes.js'
import { sagaWorld, type SagaWorld } from '../testing/saga-world.js'
import { USER_ID_HEADER } from './booking-routes.js'

/**
 * Rute operator di atas dunia saga sungguhan: pemesanan sampai NEEDS_REVIEW
 * lewat use case, unit kerja, dan basis data palsuan yang meniru transaksi —
 * bukan baris yang disisipkan langsung. Pembaca antreannya adapter produksi
 * di atas palsuan yang sama.
 */

const OPERATOR_ID = '0c4d2e8f-1a3b-4c5d-9e6f-7a8b9c0d1e2f'

function app(world: SagaWorld, options: { readonly isMounted?: boolean } = {}) {
  return createBookingHttpApp({
    deps: world.deps,
    logger: world.deps.logger,
    serviceName: 'booking-service-test',
    ...(options.isMounted === false ? {} : { reviews: createPrismaReviewReader(world.db) }),
  }).app
}

const asOperator = { [USER_ID_HEADER]: OPERATOR_ID, [USER_ROLE_HEADER]: 'operator' }

async function inReview(world: SagaWorld, key: string) {
  const paid = await world.paid(key)
  await world.supplierUncertain(paid)
  return await world.booking(paid.id)
}

describe('penjagaan /ops/bookings di service', () => {
  test('tanpa identitas 401, pelanggan 403 — termasuk pemilik pemesanannya sendiri', async () => {
    const world = sagaWorld()
    const booking = await inReview(world, 'req-ops-guard-0001')

    expect((await request(app(world)).get('/ops/bookings/review')).status).toBe(401)
    const owner = await request(app(world))
      .get(`/ops/bookings/${booking.id}`)
      .set(USER_ID_HEADER, USER)
      .set(USER_ROLE_HEADER, 'customer')
    expect(owner.status).toBe(403)
  })

  test('tanpa pembaca antrean, rute operator tidak ada sama sekali', async () => {
    const world = sagaWorld()

    const response = await request(app(world, { isMounted: false }))
      .get('/ops/bookings/review')
      .set(asOperator)

    expect(response.status).toBe(404)
  })
})

describe('GET /ops/bookings/review', () => {
  test('memuat jejak audit, saga, kunci ke supplier, dan pembayaran — konteks untuk memutuskan', async () => {
    const world = sagaWorld()
    const booking = await inReview(world, 'req-ops-review-0001')

    const response = await request(app(world)).get('/ops/bookings/review').set(asOperator)

    expect(response.status).toBe(200)
    expect(response.body.data).toHaveLength(1)
    const [item] = response.body.data
    expect(item.booking).toMatchObject({
      id: booking.id,
      status: 'NEEDS_REVIEW',
      paymentId: booking.paymentId,
      review: { from: 'PAID' },
      leadGuest: { fullName: booking.guests.leadGuest.fullName },
    })
    expect(item.supplierIdempotencyKey).toBe(booking.id)
    expect(item.saga).toMatchObject({ phase: 'review', compensation: 'skipped' })
    expect(item.trail.map((entry: { type: string }) => entry.type)).toEqual([
      'BookingCreated',
      'PriceVerified',
      'BookingHeld',
      'PaymentRecorded',
      'ReviewRequired',
    ])
    expect(item.trail.map((entry: { sequence: number }) => entry.sequence)).toEqual([1, 2, 3, 4, 5])
  })

  test('hanya NEEDS_REVIEW, yang paling lama menunggu lebih dulu, dan dibatasi `limit`', async () => {
    const world = sagaWorld()
    const first = await inReview(world, 'req-ops-order-0001')
    world.advance(60_000)
    const second = await inReview(world, 'req-ops-order-0002')
    await world.held('req-ops-order-0003')

    const all = await request(app(world)).get('/ops/bookings/review').set(asOperator)
    const one = await request(app(world)).get('/ops/bookings/review?limit=1').set(asOperator)

    expect(all.body.data.map((item: { booking: { id: string } }) => item.booking.id)).toEqual([
      first.id,
      second.id,
    ])
    expect(one.body.data).toHaveLength(1)
  })

  test('limit di luar batas ditolak 400', async () => {
    const world = sagaWorld()

    const response = await request(app(world)).get('/ops/bookings/review?limit=0').set(asOperator)

    expect(response.status).toBe(400)
  })
})

describe('GET /ops/bookings/:id', () => {
  test('pemesanan dalam keadaan apa pun dapat dibuka, dengan saganya yang sedang berjalan', async () => {
    const world = sagaWorld()
    const paid = await world.paid('req-ops-detail-0001')

    const response = await request(app(world)).get(`/ops/bookings/${paid.id}`).set(asOperator)

    expect(response.status).toBe(200)
    expect(response.body.data.booking.status).toBe('PAID')
    expect(response.body.data.saga).toMatchObject({ phase: 'running', stepStatus: 'waiting' })
  })

  test('sebelum hold: tanpa pembayaran dan tanpa saga — keduanya null, bukan galat', async () => {
    const world = sagaWorld()
    const checked = await startPriceCheck(
      world.deps,
      priceCheckRequest({ key: 'req-ops-early-0001' }),
    )
    if (checked.kind !== 'checked') throw new Error(`persiapan gagal: ${checked.kind}`)

    const response = await request(app(world))
      .get(`/ops/bookings/${checked.booking.id}`)
      .set(asOperator)

    expect(response.body.data.booking).toMatchObject({ status: 'PRICE_CHECKED', paymentId: null })
    expect(response.body.data.saga).toBeNull()
  })

  test('pemesanan yang direfund menunjukkan alasan kegagalan dan pengenal refund', async () => {
    const world = sagaWorld()
    const paid = await world.paid('req-ops-refund-0001')
    await world.supplierRejected(paid)
    await world.paymentRefunded(paid)

    const response = await request(app(world)).get(`/ops/bookings/${paid.id}`).set(asOperator)

    expect(response.body.data.booking.status).toBe('REFUNDED')
    expect(response.body.data.booking.refundId).toEqual(expect.any(String))
    expect(response.body.data.booking.failureReason).toEqual(expect.any(String))
  })

  test('pemesanan yang tidak ada: 404; pengenal bukan UUID: 400', async () => {
    const world = sagaWorld()

    const missing = await request(app(world))
      .get('/ops/bookings/0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f')
      .set(asOperator)
    const malformed = await request(app(world)).get('/ops/bookings/bukan-uuid').set(asOperator)

    expect(missing.status).toBe(404)
    expect(malformed.status).toBe(400)
  })
})
