import type { Express } from 'express'
import request from 'supertest'
import { describe, expect, test } from 'vitest'
import { createBookingHttpApp } from '../composition/app.js'
import { cancellationWorld, type CancellationWorld } from '../testing/cancellation-world.js'
import { OTHER_USER, USER } from '../testing/fakes.js'
import { USER_ID_HEADER } from './booking-routes.js'

function app(world: CancellationWorld): Express {
  return createBookingHttpApp({
    deps: world.deps,
    logger: world.deps.logger,
    serviceName: 'booking-service-test',
  }).app
}

const PAID = { amountMinor: 2_442_000, currency: 'IDR' }
const HOUR = 3_600_000
const BALI_CHECK_IN_STARTS = Date.parse('2026-11-09T16:00:00Z')

describe('GET /bookings/:id/cancellation-preview', () => {
  test('menyebut nilai yang kembali dan seluruh tenggat sebagai titik waktu di zona properti', async () => {
    const world = cancellationWorld()
    const booking = await world.confirmed()

    const response = await request(app(world))
      .get(`/bookings/${booking.id}/cancellation-preview`)
      .set(USER_ID_HEADER, USER)

    expect(response.status).toBe(200)
    expect(response.body.data).toEqual({
      bookingId: booking.id,
      cancellable: true,
      paid: PAID,
      quote: {
        refund: PAID,
        percent: 100,
        until: '2026-11-06T16:00:00.000Z',
        next: { percent: 50 },
        nothingBack: null,
        tiers: [
          { percent: 100, until: '2026-11-06T16:00:00.000Z' },
          { percent: 50, until: '2026-11-08T16:00:00.000Z' },
          { percent: 0, until: '2026-11-09T16:00:00.000Z' },
        ],
        checkInStartsAt: '2026-11-09T16:00:00.000Z',
        timeZone: 'Asia/Makassar',
      },
      serverTime: world.now().toISOString(),
    })
  })

  test('setelah tenggat: nol, dengan tenggat terakhir yang terlewat', async () => {
    const world = cancellationWorld()
    const booking = await world.confirmed()
    world.advance(BALI_CHECK_IN_STARTS - 2 * HOUR - world.now().getTime())

    const response = await request(app(world))
      .get(`/bookings/${booking.id}/cancellation-preview`)
      .set(USER_ID_HEADER, USER)

    expect(response.body.data.quote).toMatchObject({
      refund: { amountMinor: 0, currency: 'IDR' },
      next: null,
      nothingBack: {
        kind: 'past_deadline',
        lastRefund: { percent: 50, until: '2026-11-08T16:00:00.000Z' },
      },
    })
  })

  test('rate non-refundable dijelaskan sebagai non-refundable', async () => {
    const world = cancellationWorld()
    world.suppliers.supplierPolicy = { refundable: false }
    const booking = await world.confirmed()

    const response = await request(app(world))
      .get(`/bookings/${booking.id}/cancellation-preview`)
      .set(USER_ID_HEADER, USER)

    expect(response.body.data.quote.nothingBack).toEqual({ kind: 'non_refundable' })
  })

  test('pemesanan yang tidak dapat dibatalkan dijawab 200 dengan alasan dan kalimatnya', async () => {
    const world = cancellationWorld()
    const held = await world.held()

    const response = await request(app(world))
      .get(`/bookings/${held.id}/cancellation-preview`)
      .set(USER_ID_HEADER, USER)

    expect(response.status).toBe(200)
    expect(response.body.data).toMatchObject({
      cancellable: false,
      reason: 'not_confirmed',
      message: expect.stringContaining('belum terkonfirmasi'),
    })
  })

  test('katalog yang belum menjawab dijawab 503', async () => {
    const world = cancellationWorld()
    const booking = await world.confirmed()
    world.properties.answer = { kind: 'unreachable' }

    const response = await request(app(world))
      .get(`/bookings/${booking.id}/cancellation-preview`)
      .set(USER_ID_HEADER, USER)

    expect(response.status).toBe(503)
    expect(response.body.error.code).toBe('CATALOG_UNAVAILABLE')
  })

  test('pemesanan orang lain dijawab 404', async () => {
    const world = cancellationWorld()
    const booking = await world.confirmed()

    const response = await request(app(world))
      .get(`/bookings/${booking.id}/cancellation-preview`)
      .set(USER_ID_HEADER, OTHER_USER)

    expect(response.status).toBe(404)
  })

  test('tanpa identitas dijawab 401', async () => {
    const world = cancellationWorld()
    const booking = await world.confirmed()

    const response = await request(app(world)).get(`/bookings/${booking.id}/cancellation-preview`)

    expect(response.status).toBe(401)
  })
})

describe('POST /bookings/:id/cancel', () => {
  test('diterima 202 dengan pembatalan yang sedang menunggu supplier', async () => {
    const world = cancellationWorld()
    const booking = await world.confirmed()

    const response = await request(app(world))
      .post(`/bookings/${booking.id}/cancel`)
      .set(USER_ID_HEADER, USER)
      .send({ expectedRefund: PAID })

    expect(response.status).toBe(202)
    expect(response.body.data).toMatchObject({
      status: 'CANCELLING',
      cancellation: { step: 'supplier', refund: PAID, percent: 100 },
    })
  })

  test('nilai pengembalian wajib disertakan', async () => {
    const world = cancellationWorld()
    const booking = await world.confirmed()

    const response = await request(app(world))
      .post(`/bookings/${booking.id}/cancel`)
      .set(USER_ID_HEADER, USER)
      .send({})

    expect(response.status).toBe(400)
    expect((await world.booking(booking.id)).status).toBe('CONFIRMED')
  })

  test('nilai yang sudah berubah dijawab 409 dengan pratinjau baru, tanpa pembatalan', async () => {
    const world = cancellationWorld()
    const booking = await world.confirmed()
    world.advance(BALI_CHECK_IN_STARTS - 48 * HOUR - world.now().getTime())

    const response = await request(app(world))
      .post(`/bookings/${booking.id}/cancel`)
      .set(USER_ID_HEADER, USER)
      .send({ expectedRefund: PAID })

    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('REFUND_CHANGED')
    expect(response.body.error.details.quote).toMatchObject({
      percent: 50,
      refund: { amountMinor: 1_221_000, currency: 'IDR' },
    })
    expect((await world.booking(booking.id)).status).toBe('CONFIRMED')
  })

  test('pemesanan yang tidak dapat dibatalkan dijawab 409 dengan alasannya', async () => {
    const world = cancellationWorld()
    const held = await world.held()

    const response = await request(app(world))
      .post(`/bookings/${held.id}/cancel`)
      .set(USER_ID_HEADER, USER)
      .send({ expectedRefund: PAID })

    expect(response.status).toBe(409)
    expect(response.body.error).toMatchObject({
      code: 'NOT_CANCELLABLE',
      details: { reason: 'not_confirmed' },
    })
  })

  test('katalog yang belum menjawab dijawab 503', async () => {
    const world = cancellationWorld()
    const booking = await world.confirmed()
    world.properties.answer = { kind: 'unreachable' }

    const response = await request(app(world))
      .post(`/bookings/${booking.id}/cancel`)
      .set(USER_ID_HEADER, USER)
      .send({ expectedRefund: PAID })

    expect(response.status).toBe(503)
  })

  test('pemesanan orang lain dijawab 404', async () => {
    const world = cancellationWorld()
    const booking = await world.confirmed()

    const response = await request(app(world))
      .post(`/bookings/${booking.id}/cancel`)
      .set(USER_ID_HEADER, OTHER_USER)
      .send({ expectedRefund: PAID })

    expect(response.status).toBe(404)
  })

  test('status pemesanan mengikuti pembatalan sampai refund tuntas', async () => {
    const world = cancellationWorld()
    const booking = await world.confirmed()
    await world.cancel(booking)
    await world.supplierCancelled(booking)
    const status = async (): Promise<unknown> => {
      const response = await request(app(world))
        .get(`/bookings/${booking.id}/status`)
        .set(USER_ID_HEADER, USER)
      return response.body.data as unknown
    }

    expect(await status()).toMatchObject({
      status: 'CANCELLING',
      refund: 'pending',
      cancellation: { step: 'refund' },
    })

    await world.paymentRefunded(booking)

    expect(await status()).toMatchObject({
      status: 'CANCELLED',
      isFinal: true,
      refund: 'completed',
      cancellation: { step: 'done' },
    })
  })
})
