import { describe, expect, test } from 'vitest'
import type { Booking } from '../domain/booking.js'
import { applyCommand } from '../domain/transitions.js'
import { validCommand } from '../testing/builders.js'
import {
  harness,
  HOLD_DURATION_MS,
  OTHER_USER,
  priceCheckRequest,
  scriptedPayments,
  type Harness,
} from '../testing/fakes.js'
import { placeHold } from './place-hold.js'
import { startPriceCheck } from './price-check.js'
import { paymentKeyOf, startPayment } from './start-payment.js'

async function heldBooking(world: Harness): Promise<Booking> {
  const checked = await startPriceCheck(world.deps, priceCheckRequest())
  if (checked.kind !== 'checked') throw new Error(`persiapan gagal: ${checked.kind}`)
  const held = await placeHold(world.deps, {
    userId: checked.booking.userId,
    bookingId: checked.booking.id,
    unitsLeft: 5,
  })
  if (held.kind !== 'held') throw new Error(`persiapan gagal: ${held.kind}`)
  return held.booking
}

describe('membuka pembayaran untuk pemesanan HELD (FR-19)', () => {
  test('meminta payment-service menagih harga yang DISETUJUI, dengan kunci per pemesanan', async () => {
    const world = harness()
    const payments = scriptedPayments()
    const booking = await heldBooking(world)

    const result = await startPayment(world.deps, payments, {
      userId: booking.userId,
      bookingId: booking.id,
    })

    expect(result.kind).toBe('started')
    if (result.kind !== 'started') return
    expect(result.snapToken).toBe(`snap-${booking.id}`)
    // Nilainya dari pemesanan, bukan dari klien: klien tidak mengirim harga.
    expect(payments.requests).toEqual([
      {
        bookingId: booking.id,
        idempotencyKey: paymentKeyOf(booking.id),
        amount: booking.price.total,
      },
    ])
  })

  test('permintaan berulang memakai kunci yang sama — satu pembayaran, bukan dua', async () => {
    const world = harness()
    const payments = scriptedPayments()
    const booking = await heldBooking(world)
    const request = { userId: booking.userId, bookingId: booking.id }

    await startPayment(world.deps, payments, request)
    await startPayment(world.deps, payments, request)

    expect(new Set(payments.requests.map((sent) => sent.idempotencyKey)).size).toBe(1)
  })

  test('pemesanan milik orang lain dijawab sama dengan yang tidak ada', async () => {
    const world = harness()
    const payments = scriptedPayments()
    const booking = await heldBooking(world)

    const result = await startPayment(world.deps, payments, {
      userId: OTHER_USER,
      bookingId: booking.id,
    })

    expect(result).toEqual({ kind: 'not_found' })
    expect(payments.requests).toEqual([])
  })

  test('hold yang sudah lewat tidak dibukakan pembayaran, meski penyapu belum berjalan', async () => {
    const world = harness()
    const payments = scriptedPayments()
    const booking = await heldBooking(world)
    world.advance(HOLD_DURATION_MS)

    const result = await startPayment(world.deps, payments, {
      userId: booking.userId,
      bookingId: booking.id,
    })

    expect(result.kind).toBe('hold_expired')
    expect(payments.requests).toEqual([])
  })

  test('pemesanan yang belum di-hold tidak dapat dibayar', async () => {
    const world = harness()
    const payments = scriptedPayments()
    const checked = await startPriceCheck(world.deps, priceCheckRequest())
    if (checked.kind !== 'checked') throw new Error('persiapan gagal')

    const result = await startPayment(world.deps, payments, {
      userId: checked.booking.userId,
      bookingId: checked.booking.id,
    })

    expect(result.kind).toBe('not_payable')
    expect(payments.requests).toEqual([])
  })

  test('pemesanan yang sudah melewati pembayaran diarahkan ke statusnya', async () => {
    const world = harness()
    const payments = scriptedPayments()
    const booking = await heldBooking(world)
    const paid = applyCommand(booking, validCommand(booking, 'recordPayment'))
    if (!paid.ok) throw new Error(paid.error.message)
    await world.deps.bookings.save(paid.value)

    const result = await startPayment(world.deps, payments, {
      userId: booking.userId,
      bookingId: booking.id,
    })

    expect(result.kind).toBe('already_paid')
  })

  test.each([
    ['payment-service belum mengenal harganya', { kind: 'not_ready' as const }, 'retry_later'],
    ['payment-service tidak dapat dihubungi', { kind: 'unreachable' as const }, 'retry_later'],
    ['penyedia menolak', { kind: 'rejected' as const }, 'rejected'],
    [
      'pembayaran untuk pemesanan ini sudah selesai',
      { kind: 'settled' as const, paymentId: 'pay-1', status: 'SUCCEEDED' },
      'already_paid',
    ],
  ])('%s', async (_name, answer, expected) => {
    const world = harness()
    const payments = scriptedPayments()
    payments.next(answer)
    const booking = await heldBooking(world)

    const result = await startPayment(world.deps, payments, {
      userId: booking.userId,
      bookingId: booking.id,
    })

    expect(result.kind).toBe(expected)
  })
})
