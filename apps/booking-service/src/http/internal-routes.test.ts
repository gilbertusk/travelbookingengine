import type { Express } from 'express'
import request from 'supertest'
import { describe, expect, test } from 'vitest'
import { createBookingHttpApp } from '../composition/app.js'
import { priceCheckRequest, USER } from '../testing/fakes.js'
import { sagaWorld, type SagaWorld } from '../testing/saga-world.js'

function app(world: SagaWorld): Express {
  return createBookingHttpApp({
    deps: world.deps,
    logger: world.deps.logger,
    serviceName: 'booking-service-test',
  }).app
}

describe('GET /internal/bookings/:id/voucher-source', () => {
  test('pemesanan CONFIRMED membawa seluruh bahan e-voucher', async () => {
    const world = sagaWorld()
    const paid = await world.paid()
    await world.supplierConfirmed(paid)

    const response = await request(app(world)).get(`/internal/bookings/${paid.id}/voucher-source`)

    expect(response.status).toBe(200)
    const data = response.body.data
    expect(data).toMatchObject({
      id: paid.id,
      userId: USER,
      status: 'CONFIRMED',
      supplier: 'SKY',
      checkIn: '2026-11-10',
      checkOut: '2026-11-12',
      guests: { count: 2, leadGuestName: 'Sari Wulandari' },
      terms: priceCheckRequest().offer,
    })
    expect(data.supplierRef).toEqual(expect.any(String))
    expect(data.confirmedAt).toEqual(expect.any(String))
    expect(data.price.lineItems.length).toBeGreaterThan(0)
  })

  test('surel tamu tidak ikut keluar', async () => {
    const world = sagaWorld()
    const paid = await world.paid()

    const response = await request(app(world)).get(`/internal/bookings/${paid.id}/voucher-source`)

    expect(JSON.stringify(response.body)).not.toContain('sari@example.com')
  })

  test('pemesanan yang belum CONFIRMED tidak punya booking reference maupun waktu konfirmasi', async () => {
    const world = sagaWorld()
    const paid = await world.paid()

    const response = await request(app(world)).get(`/internal/bookings/${paid.id}/voucher-source`)

    expect(response.body.data).toMatchObject({
      status: 'PAID',
      supplierRef: null,
      confirmedAt: null,
    })
  })

  test('pemesanan yang tidak ada dijawab 404', async () => {
    const world = sagaWorld()

    const response = await request(app(world)).get(
      '/internal/bookings/00000000-0000-4000-8000-000000000000/voucher-source',
    )

    expect(response.status).toBe(404)
  })

  test('pengenal yang bukan UUID dijawab 400', async () => {
    const response = await request(app(sagaWorld())).get('/internal/bookings/abc/voucher-source')

    expect(response.status).toBe(400)
  })
})

describe('GET /internal/bookings/:id/notification-source', () => {
  test('membawa alamat surel tamu utama, karena itulah tujuan pemberitahuan', async () => {
    const world = sagaWorld()
    const paid = await world.paid()
    await world.supplierConfirmed(paid)

    const response = await request(app(world)).get(
      `/internal/bookings/${paid.id}/notification-source`,
    )

    expect(response.status).toBe(200)
    expect(response.body.data).toMatchObject({
      id: paid.id,
      userId: USER,
      status: 'CONFIRMED',
      checkIn: '2026-11-10',
      checkOut: '2026-11-12',
      guestCount: 2,
      leadGuest: { fullName: 'Sari Wulandari', email: 'sari@example.com' },
      roomTypeName: priceCheckRequest().offer.roomTypeName,
      total: { amountMinor: expect.any(Number), currency: 'IDR' },
    })
    expect(response.body.data.supplierRef).toEqual(expect.any(String))
  })

  test('tidak membawa rincian harga, ketentuan, maupun pengenal supplier yang tidak dipakai surel', async () => {
    const world = sagaWorld()
    const paid = await world.paid()

    const response = await request(app(world)).get(
      `/internal/bookings/${paid.id}/notification-source`,
    )

    expect(Object.keys(response.body.data).sort()).toEqual(
      [
        'checkIn',
        'checkOut',
        'guestCount',
        'id',
        'leadGuest',
        'roomTypeName',
        'status',
        'supplierRef',
        'total',
        'userId',
      ].sort(),
    )
  })

  test('pemesanan yang tidak ada dijawab 404', async () => {
    const response = await request(app(sagaWorld())).get(
      '/internal/bookings/00000000-0000-4000-8000-000000000000/notification-source',
    )

    expect(response.status).toBe(404)
  })
})
