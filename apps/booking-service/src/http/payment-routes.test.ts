import type { Express } from 'express'
import request from 'supertest'
import { describe, expect, test } from 'vitest'
import type { PaymentStart } from '../application/ports.js'
import { placeHold } from '../application/place-hold.js'
import { startPriceCheck } from '../application/price-check.js'
import { createBookingHttpApp } from '../composition/app.js'
import {
  harness,
  HOLD_DURATION_MS,
  OTHER_USER,
  priceCheckRequest,
  scriptedPayments,
  type Harness,
  type ScriptedPayments,
} from '../testing/fakes.js'
import { USER_ID_HEADER } from './booking-routes.js'

function app(world: Harness, payments: ScriptedPayments): Express {
  return createBookingHttpApp({
    deps: world.deps,
    logger: world.deps.logger,
    serviceName: 'booking-service-test',
    payments,
  }).app
}

async function held(world: Harness): Promise<{ id: string; userId: string }> {
  const checked = await startPriceCheck(world.deps, priceCheckRequest())
  if (checked.kind !== 'checked') throw new Error('persiapan gagal')
  const result = await placeHold(world.deps, {
    userId: checked.booking.userId,
    bookingId: checked.booking.id,
    unitsLeft: 5,
  })
  if (result.kind !== 'held') throw new Error('persiapan gagal')
  return { id: result.booking.id, userId: result.booking.userId }
}

describe('POST /bookings/:id/payment', () => {
  test('membuka pembayaran: token Snap, tautan, pemesanan, dan jam server', async () => {
    const world = harness()
    const payments = scriptedPayments()
    const booking = await held(world)

    const response = await request(app(world, payments))
      .post(`/bookings/${booking.id}/payment`)
      .set(USER_ID_HEADER, booking.userId)

    expect(response.status).toBe(200)
    expect(response.body.data.snapToken).toBe(`snap-${booking.id}`)
    expect(response.body.data.redirectUrl).toContain('https://')
    expect(response.body.data.booking.status).toBe('HELD')
    expect(response.body.data.booking.serverTime).toBe(world.now().toISOString())
  })

  test('pemesanan orang lain dijawab 404', async () => {
    const world = harness()
    const payments = scriptedPayments()
    const booking = await held(world)

    const response = await request(app(world, payments))
      .post(`/bookings/${booking.id}/payment`)
      .set(USER_ID_HEADER, OTHER_USER)

    expect(response.status).toBe(404)
    expect(payments.requests).toEqual([])
  })

  test('hold yang sudah lewat dijawab 409 HOLD_EXPIRED', async () => {
    const world = harness()
    const payments = scriptedPayments()
    const booking = await held(world)
    world.advance(HOLD_DURATION_MS)

    const response = await request(app(world, payments))
      .post(`/bookings/${booking.id}/payment`)
      .set(USER_ID_HEADER, booking.userId)

    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('HOLD_EXPIRED')
  })

  test.each<[string, PaymentStart, number, string]>([
    ['harga belum dikenal payment-service', { kind: 'not_ready' }, 503, 'PAYMENT_UNAVAILABLE'],
    ['penyedia menolak', { kind: 'rejected' }, 402, 'PAYMENT_REJECTED'],
    [
      'pembayaran sudah selesai',
      { kind: 'settled', paymentId: 'p', status: 'SUCCEEDED' },
      409,
      'ALREADY_PAID',
    ],
  ])('%s', async (_name, answer, status, code) => {
    const world = harness()
    const payments = scriptedPayments()
    payments.next(answer)
    const booking = await held(world)

    const response = await request(app(world, payments))
      .post(`/bookings/${booking.id}/payment`)
      .set(USER_ID_HEADER, booking.userId)

    expect(response.status).toBe(status)
    expect(response.body.error.code).toBe(code)
  })

  test('pemesanan yang belum di-hold dijawab 409 NOT_PAYABLE', async () => {
    const world = harness()
    const payments = scriptedPayments()
    const checked = await startPriceCheck(world.deps, priceCheckRequest())
    if (checked.kind !== 'checked') throw new Error('persiapan gagal')

    const response = await request(app(world, payments))
      .post(`/bookings/${checked.booking.id}/payment`)
      .set(USER_ID_HEADER, checked.booking.userId)

    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('NOT_PAYABLE')
  })

  test('tanpa payments yang dirangkai, rutenya tidak ada', async () => {
    const world = harness()
    const booking = await held(world)
    const bare = createBookingHttpApp({
      deps: world.deps,
      logger: world.deps.logger,
      serviceName: 'booking-service-test',
    }).app

    const response = await request(bare)
      .post(`/bookings/${booking.id}/payment`)
      .set(USER_ID_HEADER, booking.userId)

    expect(response.status).toBe(404)
  })
})
