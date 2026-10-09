import request from 'supertest'
import { describe, expect, test } from 'vitest'
import { createBookingHttpApp } from '../composition/app.js'
import { cancellationWorld, type CancellationWorld } from '../testing/cancellation-world.js'
import { OTHER_USER, USER } from '../testing/fakes.js'
import { USER_ID_HEADER } from './booking-routes.js'

function app(world: CancellationWorld) {
  return createBookingHttpApp({
    deps: world.deps,
    logger: world.deps.logger,
    serviceName: 'booking-service-test',
  }).app
}

describe('GET /bookings', () => {
  test('entri membawa properti, tanggal, booking reference, status, dan nilai', async () => {
    const world = cancellationWorld()
    const booking = await world.confirmed()

    const response = await request(app(world)).get('/bookings').set(USER_ID_HEADER, USER)

    expect(response.status).toBe(200)
    expect(response.body.data).toEqual({
      items: [
        {
          id: booking.id,
          status: 'CONFIRMED',
          isFinal: true,
          propertyName: 'Villa Sawah Ubud',
          city: 'Denpasar',
          roomTypeName: 'Deluxe King',
          checkIn: '2026-11-10',
          checkOut: '2026-11-12',
          guests: 2,
          supplierRef: 'SKY-BK-778812',
          total: { amountMinor: 2_442_000, currency: 'IDR' },
          refund: null,
          review: null,
          cancellation: null,
        },
      ],
      nextCursor: null,
    })
  })

  test('kelompok dibatalkan memuat pembatalan oleh pengguna beserta nilainya', async () => {
    const world = cancellationWorld()
    const booking = await world.confirmed()
    await world.cancel(booking)
    await world.supplierCancelled(booking)
    await world.paymentRefunded(booking)

    const response = await request(app(world))
      .get('/bookings?group=cancelled')
      .set(USER_ID_HEADER, USER)

    expect(response.body.data.items).toMatchObject([
      {
        id: booking.id,
        status: 'CANCELLED',
        refund: 'completed',
        cancellation: { step: 'done', percent: 100 },
      },
    ])
  })

  test('berhalaman: penunjuk berikutnya dan batas ukuran', async () => {
    const world = cancellationWorld()
    await world.confirmed('req-2026-10-01-0001')
    await world.confirmed('req-2026-10-01-0002')

    const first = await request(app(world)).get('/bookings?limit=1').set(USER_ID_HEADER, USER)
    const second = await request(app(world))
      .get(`/bookings?limit=1&cursor=${String(first.body.data.nextCursor)}`)
      .set(USER_ID_HEADER, USER)

    expect(first.body.data.items).toHaveLength(1)
    expect(first.body.data.nextCursor).toBe('1')
    expect(second.body.data.items).toHaveLength(1)
    expect(second.body.data.nextCursor).toBeNull()
  })

  test.each([['group=semua'], ['limit=500'], ['cursor=abc']])('%s ditolak 400', async (query) => {
    const world = cancellationWorld()

    const response = await request(app(world)).get(`/bookings?${query}`).set(USER_ID_HEADER, USER)

    expect(response.status).toBe(400)
  })

  test('pemesanan pengguna lain tidak tampil', async () => {
    const world = cancellationWorld()
    await world.confirmed()

    const response = await request(app(world)).get('/bookings').set(USER_ID_HEADER, OTHER_USER)

    expect(response.body.data.items).toEqual([])
  })
})

describe('GET /bookings/:id untuk halaman detail', () => {
  test('membawa nama properti, booking reference, dan ketentuan versi supplier', async () => {
    const world = cancellationWorld()
    const booking = await world.confirmed()

    const response = await request(app(world))
      .get(`/bookings/${booking.id}`)
      .set(USER_ID_HEADER, USER)

    expect(response.body.data).toMatchObject({
      propertyName: 'Villa Sawah Ubud',
      supplierRef: 'SKY-BK-778812',
      terms: {
        roomTypeName: 'Deluxe King',
        cancellationPolicy: { refundable: true, freeCancellationDays: 3 },
      },
    })
  })

  test('katalog yang tidak menjawab tidak menggagalkan halaman', async () => {
    const world = cancellationWorld()
    const booking = await world.confirmed()
    world.properties.answer = { kind: 'not_found' }

    const response = await request(app(world))
      .get(`/bookings/${booking.id}`)
      .set(USER_ID_HEADER, USER)

    expect(response.status).toBe(200)
    expect(response.body.data.propertyName).toBeNull()
  })
})
