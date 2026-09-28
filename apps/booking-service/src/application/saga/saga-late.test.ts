import { describe, expect, test } from 'vitest'
import {
  ERROR_LEVEL,
  HOLD_DURATION_MS,
  priceCheckRequest,
  SAGA_POLICY,
} from '../../testing/fakes.js'
import { PAYMENT_ID, SUPPLIER_REF, sagaWorld } from '../../testing/saga-world.js'
import { expireHold } from '../expire-hold.js'
import { persist } from '../persist.js'
import { startPriceCheck } from '../price-check.js'
import { refundRequestIdFor } from './commands.js'
import { sweepSagas } from './sweep-sagas.js'

/**
 * Fakta yang tiba TERLAMBAT — setelah saga memutuskan lain.
 *
 * Jaminan step doc 19: tidak ada pembayaran berhasil tanpa pemesanan
 * terkonfirmasi atau refund, dan tidak ada pemesanan di supplier yang
 * dibiarkan setelah uang penggunanya dikembalikan.
 */

describe('pembayaran yang tiba setelah pemesanan tidak dapat menerimanya', () => {
  test('setelah hold kedaluwarsa: refund diminta dan dilacak saga sampai terkonfirmasi', async () => {
    const world = sagaWorld()
    const held = await world.held()
    world.advance(HOLD_DURATION_MS)
    await expireHold(world.deps, held.id)

    await world.paymentSucceeded(held)

    expect(await world.booking(held.id)).toMatchObject({ status: 'EXPIRED' })
    const refund = world.outbox().find((row) => row.messageType === 'payment.refund')
    expect(refund?.payload).toMatchObject({ reason: 'manual', paymentId: PAYMENT_ID })
    expect(await world.saga(held.id)).toMatchObject({ phase: 'compensating' })

    expect(await world.paymentRefunded(held)).toBe('applied')
    expect(await world.saga(held.id)).toMatchObject({ phase: 'compensated' })
  })

  test('refund pembayaran terlambat yang tidak terkonfirmasi diserahkan ke manusia', async () => {
    const world = sagaWorld()
    const held = await world.held()
    world.advance(HOLD_DURATION_MS)
    await expireHold(world.deps, held.id)
    await world.paymentSucceeded(held)
    world.advance(SAGA_POLICY.awaitRefundTimeoutMs)

    await sweepSagas(world.deps)

    // Pemesanan EXPIRED final dan tidak berpindah; sagalah yang menandainya.
    expect(await world.booking(held.id)).toMatchObject({ status: 'EXPIRED' })
    expect(await world.saga(held.id)).toMatchObject({ phase: 'review', compensation: 'failed' })
    expect(world.logs().some((entry) => entry.level === ERROR_LEVEL)).toBe(true)
  })

  test('pemesanan yang dibatalkan pengguna sebelum hold: refund beralasan user_cancelled', async () => {
    const world = sagaWorld()
    const checked = await startPriceCheck(world.deps, priceCheckRequest())
    if (checked.kind !== 'checked') throw new Error('persiapan gagal')
    await persist(world.deps, checked.booking, {
      type: 'cancel',
      at: world.now(),
      reason: 'user_request',
    })

    await world.paymentSucceeded(checked.booking)

    const refund = world.outbox().find((row) => row.messageType === 'payment.refund')
    expect(refund?.payload).toMatchObject({ reason: 'user_cancelled' })
  })

  test('pemesanan tanpa saga — dibatalkan saat price check — tetap mengembalikan uangnya', async () => {
    const world = sagaWorld()
    world.suppliers.nextPrice({ kind: 'rejected', reason: 'sold_out' })
    const held = await world.held().catch(() => undefined)
    expect(held).toBeUndefined()
    const [cancelled] = [...world.db.committed().bookings.values()]
    if (cancelled === undefined) throw new Error('persiapan gagal')
    const booking = await world.booking(cancelled.id)

    await world.paymentSucceeded(booking)

    expect(world.sent(booking.id)).toContain('payment.refund')
    expect(await world.saga(booking.id)).toMatchObject({ phase: 'compensating', version: 1 })
  })

  test('pengenal refund turunan dari pemesanan dan pembayarannya', async () => {
    const world = sagaWorld()
    const held = await world.held()
    world.advance(HOLD_DURATION_MS)
    await expireHold(world.deps, held.id)

    await world.paymentSucceeded(held)

    const refund = world.outbox().find((row) => row.messageType === 'payment.refund')
    expect(refund?.payload).toMatchObject({
      refundRequestId: refundRequestIdFor(held.id, PAYMENT_ID),
    })
  })
})

describe('konfirmasi supplier yang tiba setelah saga memutuskan gagal', () => {
  test('saat refund berjalan: pemesanan supplier dibatalkan dan diserahkan ke manusia', async () => {
    const world = sagaWorld()
    const paid = await world.paid()
    await world.supplierRejected(paid)

    expect(await world.supplierConfirmed(paid)).toBe('applied')

    expect(await world.booking(paid.id)).toMatchObject({ status: 'NEEDS_REVIEW' })
    const cancel = world.outbox().find((row) => row.messageType === 'supplier.cancel')
    expect(cancel?.payload).toMatchObject({ bookingId: paid.id, supplierRef: SUPPLIER_REF })
    expect(await world.saga(paid.id)).toMatchObject({ phase: 'review', compensation: 'failed' })
  })

  test('setelah refund selesai: pemesanan supplier tetap dibatalkan', async () => {
    const world = sagaWorld()
    const paid = await world.paid()
    await world.supplierRejected(paid)
    await world.paymentRefunded(paid)

    await world.supplierConfirmed(paid)

    expect(await world.booking(paid.id)).toMatchObject({ status: 'REFUNDED' })
    expect(world.sent(paid.id)).toContain('supplier.cancel')
  })

  test('peninjauan TANPA refund: pemesanan supplier TIDAK dibatalkan — itulah yang ditunggu pengguna', async () => {
    const world = sagaWorld()
    const paid = await world.paid()
    await world.supplierUncertain(paid)

    expect(await world.supplierConfirmed(paid)).toBe('applied')

    expect(world.sent(paid.id)).not.toContain('supplier.cancel')
    const saga = await world.saga(paid.id)
    expect(saga?.lastError).toContain(SUPPLIER_REF)
  })

  test('booking reference KEDUA untuk pemesanan yang sudah terkonfirmasi dibatalkan', async () => {
    // Supplier yang mengabaikan kunci idempotensi membuat pemesanan kedua.
    // US-05: hasil akhirnya tetap satu pemesanan.
    const world = sagaWorld()
    const paid = await world.paid()
    await world.supplierConfirmed(paid)

    await world.supplierConfirmed(paid, { supplierRef: 'SKY-BK-KEDUA' })

    expect(await world.booking(paid.id)).toMatchObject({
      status: 'CONFIRMED',
      supplierRef: SUPPLIER_REF,
    })
    const cancel = world.outbox().find((row) => row.messageType === 'supplier.cancel')
    expect(cancel?.payload).toMatchObject({ supplierRef: 'SKY-BK-KEDUA' })
  })

  test('jawaban supplier untuk pemesanan yang belum dibayar diabaikan', async () => {
    const world = sagaWorld()
    const held = await world.held()

    expect(await world.supplierConfirmed(held)).toBe('ignored')
    expect(await world.supplierRejected(held)).toBe('ignored')
    expect(await world.supplierUncertain(held)).toBe('ignored')
  })
})
