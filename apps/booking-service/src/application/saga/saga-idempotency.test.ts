import { describe, expect, test } from 'vitest'
import { HOLD_DURATION_MS } from '../../testing/fakes.js'
import { OTHER_PAYMENT_ID, sagaWorld, type SagaWorld } from '../../testing/saga-world.js'
import { expireHold } from '../expire-hold.js'

/**
 * Uji wajib: "peristiwa yang sama dikonsumsi dua kali tidak menghasilkan efek
 * ganda".
 *
 * Kafka menjamin minimal sekali, dan outbox payment-service/supplier-service
 * pun minimal sekali. Pesan yang SAMA — eventId yang sama — tiba dua kali pada
 * setiap penyambungan ulang consumer. Efek yang diperiksa di sini adalah efek
 * yang mahal bila ganda: perintah di outbox (refund kedua, konfirmasi kedua)
 * dan jejak audit.
 */

function outboxCount(world: SagaWorld, type: string): number {
  return world.outbox().filter((row) => row.messageType === type).length
}

describe('pesan yang sama dua kali', () => {
  test('payment.succeeded: satu PAID, satu supplier.confirm', async () => {
    const world = sagaWorld()
    const held = await world.held()
    const id = world.eventId('pay-1')

    expect(await world.paymentSucceeded(held, { eventId: id })).toBe('applied')
    expect(await world.paymentSucceeded(held, { eventId: id })).toBe('duplicate')

    expect(outboxCount(world, 'supplier.confirm')).toBe(1)
    expect(
      world.db.committed().events.filter((e) => e.eventType === 'PaymentRecorded'),
    ).toHaveLength(1)
  })

  test('payment.succeeded yang diterbitkan ulang dengan eventId lain tetap dikenali', async () => {
    // payment-service yang mati setelah menerbitkan dan sebelum mencatatnya
    // menerbitkan ulang fakta yang sama sebagai pesan baru.
    const world = sagaWorld()
    const held = await world.held()

    await world.paymentSucceeded(held, { eventId: world.eventId('pay-a') })
    expect(await world.paymentSucceeded(held, { eventId: world.eventId('pay-b') })).toBe(
      'duplicate',
    )

    expect(outboxCount(world, 'supplier.confirm')).toBe(1)
    expect(outboxCount(world, 'payment.refund')).toBe(0)
  })

  test('supplier.booking_rejected: satu FAILED, satu refund', async () => {
    const world = sagaWorld()
    const paid = await world.paid()
    const id = world.eventId('rej-1')

    await world.supplierRejected(paid, id)
    // Pemesanan sudah FAILED: keadaanlah yang menolak pesan kedua, sebelum
    // catatan pesan terkonsumsi perlu diperiksa.
    expect(await world.supplierRejected(paid, id)).toBe('ignored')

    expect(outboxCount(world, 'payment.refund')).toBe(1)
  })

  test('supplier.booking_rejected dengan eventId lain untuk pemesanan yang sudah FAILED diabaikan', async () => {
    const world = sagaWorld()
    const paid = await world.paid()

    await world.supplierRejected(paid)
    expect(await world.supplierRejected(paid)).toBe('ignored')

    expect(outboxCount(world, 'payment.refund')).toBe(1)
  })

  test('supplier.booking_confirmed: satu CONFIRMED, satu voucher', async () => {
    const world = sagaWorld()
    const paid = await world.paid()
    const id = world.eventId('conf-1')

    await world.supplierConfirmed(paid, { eventId: id })
    expect(await world.supplierConfirmed(paid, { eventId: id })).toBe('duplicate')
    expect(await world.supplierConfirmed(paid)).toBe('duplicate')

    expect(outboxCount(world, 'voucher.generate')).toBe(1)
    expect(outboxCount(world, 'supplier.cancel')).toBe(0)
  })

  test('payment.refunded: satu REFUNDED', async () => {
    const world = sagaWorld()
    const paid = await world.paid()
    await world.supplierRejected(paid)
    const id = world.eventId('ref-1')

    await world.paymentRefunded(paid, { eventId: id })
    expect(await world.paymentRefunded(paid, { eventId: id })).toBe('ignored')

    expect(
      world.db.committed().events.filter((e) => e.eventType === 'BookingRefunded'),
    ).toHaveLength(1)
  })

  /**
   * Inilah kasus yang TIDAK dijaga mesin keadaan: pemesanan yang sudah
   * EXPIRED tidak berubah lagi, jadi tidak ada kunci versi yang menolak efek
   * kedua. Yang menjaganya hanya catatan pesan terkonsumsi.
   */
  test('pembayaran terlambat untuk hold yang kedaluwarsa: refund diminta tepat sekali', async () => {
    const world = sagaWorld()
    const held = await world.held()
    world.advance(HOLD_DURATION_MS)
    await expireHold(world.deps, held.id)
    const id = world.eventId('late-1')

    expect(await world.paymentSucceeded(held, { eventId: id })).toBe('applied')
    expect(await world.paymentSucceeded(held, { eventId: id })).toBe('duplicate')

    expect(outboxCount(world, 'payment.refund')).toBe(1)
  })

  test('peristiwa untuk pemesanan yang tidak dikenal dilewati tanpa galat', async () => {
    const world = sagaWorld()
    const held = await world.held()

    const outcome = await world.paymentFailed({
      ...held,
      id: '00000000-0000-4000-8000-00000000dead',
    })

    expect(outcome).toBe('unknown_booking')
  })

  test('pembayaran KEDUA untuk pemesanan yang sudah dibayar dikembalikan', async () => {
    // Uang kedua tidak punya pemesanan yang mengakuinya.
    const world = sagaWorld()
    const paid = await world.paid()

    expect(await world.paymentSucceeded(paid, { paymentId: OTHER_PAYMENT_ID })).toBe('applied')

    const refund = world.outbox().find((row) => row.messageType === 'payment.refund')
    expect(refund?.payload).toMatchObject({ paymentId: OTHER_PAYMENT_ID, reason: 'manual' })
    expect(await world.booking(paid.id)).toMatchObject({ status: 'PAID' })
  })
})
