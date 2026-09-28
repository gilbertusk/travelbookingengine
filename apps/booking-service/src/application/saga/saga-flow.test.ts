import { describe, expect, test } from 'vitest'
import { slotOf } from '../hold-slot.js'
import { ERROR_LEVEL, SAGA_POLICY } from '../../testing/fakes.js'
import { SUPPLIER_REF, sagaWorld } from '../../testing/saga-world.js'
import { sweepSagas } from './sweep-sagas.js'

/**
 * Uji wajib Step 19, masing-masing dengan kegagalan yang disuntikkan.
 *
 * Yang berjalan di sini adalah kode produksi seluruhnya — use case, reaksi
 * saga, repository, unit kerja, outbox — di atas basis data palsuan yang
 * MENIRU transaksi Postgres dan hold store yang MENIRU atomisitas skrip Lua.
 * CONVENTIONS.md bagian 10 melarang tiruan untuk jalur kompensasi; palsuan di
 * sini bukan tiruan yang mengembalikan jawaban tertulis, melainkan
 * implementasi yang punya sifat yang diandalkan, dengan palsuan TANDINGAN
 * yang tidak punya (memory-db.ts). Jalur yang sama dijalankan juga terhadap
 * Postgres, Redis, Kafka, dan RabbitMQ sungguhan di tests/integration.
 */

describe('alur bahagia', () => {
  test('mencapai CONFIRMED, dengan perintah dan peristiwa di outbox dalam urutan saga', async () => {
    const world = sagaWorld()
    const held = await world.held()

    expect(await world.paymentSucceeded(held)).toBe('applied')
    expect(await world.supplierConfirmed(held)).toBe('applied')

    expect(await world.booking(held.id)).toMatchObject({
      status: 'CONFIRMED',
      supplierRef: SUPPLIER_REF,
    })
    expect(await world.saga(held.id)).toMatchObject({ phase: 'completed', step: 'issueVoucher' })
    expect(world.sent(held.id)).toEqual([
      'booking.created',
      'booking.held',
      'supplier.confirm',
      'booking.confirmed',
      'voucher.generate',
    ])
  })

  test('supplier.confirm membawa token hold dan kunci idempotensi = id pemesanan', async () => {
    const world = sagaWorld()
    const held = await world.held()

    await world.paymentSucceeded(held)

    const confirm = world.outbox().find((row) => row.messageType === 'supplier.confirm')
    expect(confirm?.payload).toMatchObject({
      bookingId: held.id,
      holdRef: held.holdRef,
      idempotencyKey: held.id,
      guestName: 'Sari Wulandari',
    })
  })

  test('menunggu supplier dengan batas waktu tercatat', async () => {
    const world = sagaWorld()
    const paid = await world.paid()

    expect(await world.saga(paid.id)).toMatchObject({
      phase: 'running',
      step: 'confirmSupplier',
      stepStatus: 'waiting',
      deadlineAt: new Date(world.now().getTime() + SAGA_POLICY.confirmTimeoutMs),
    })
  })
})

describe('US-03: supplier gagal permanen setelah pembayaran', () => {
  test('mencapai REFUNDED, hold lokal terlepas, refund diminta lewat outbox', async () => {
    const world = sagaWorld()
    const paid = await world.paid()

    expect(await world.supplierRejected(paid)).toBe('applied')

    // Kompensasi berjalan mundur: refund diminta, hold lokal dilepas —
    // TANPA menunggu refund selesai.
    expect(await world.booking(paid.id)).toMatchObject({ status: 'FAILED' })
    expect(world.holds.held(slotOf(paid))).toBe(0)
    expect(world.sent(paid.id).slice(-2)).toEqual(['booking.failed', 'payment.refund'])
    expect(await world.saga(paid.id)).toMatchObject({
      phase: 'compensating',
      compensating: undefined,
    })

    expect(await world.paymentRefunded(paid)).toBe('applied')

    expect(await world.booking(paid.id)).toMatchObject({ status: 'REFUNDED' })
    expect(await world.saga(paid.id)).toMatchObject({ phase: 'compensated' })
  })

  test('booking.failed membawa tahap supplier_confirm dan TIDAK menuntut peninjauan', async () => {
    const world = sagaWorld()
    const paid = await world.paid()

    await world.supplierRejected(paid)

    const failed = world.outbox().find((row) => row.messageType === 'booking.failed')
    expect(failed?.payload).toMatchObject({
      stage: 'supplier_confirm',
      requiresManualReview: false,
    })
  })

  test('refund diminta untuk pembayaran yang tercatat, sebesar harga yang ditagih', async () => {
    const world = sagaWorld()
    const paid = await world.paid()

    await world.supplierRejected(paid)

    const refund = world.outbox().find((row) => row.messageType === 'payment.refund')
    expect(refund?.payload).toMatchObject({
      bookingId: paid.id,
      paymentId: paid.paymentId,
      amount: { amountMinor: paid.price.total.amountMinor, currency: 'IDR' },
      reason: 'supplier_failed',
    })
  })

  test('refund sebagian bukan akhir yang sah: NEEDS_REVIEW dengan galat tingkat error', async () => {
    const world = sagaWorld()
    const paid = await world.paid()
    await world.supplierRejected(paid)

    await world.paymentRefunded(paid, {
      amount: { ...paid.price.total, amountMinor: paid.price.total.amountMinor - 1_000 },
    })

    expect(await world.booking(paid.id)).toMatchObject({ status: 'NEEDS_REVIEW' })
    expect(world.logs().some((entry) => entry.level === ERROR_LEVEL)).toBe(true)
  })
})

describe('pembayaran gagal setelah hold', () => {
  test('hold terlepas dan pemesanan CANCELLED, tanpa refund', async () => {
    const world = sagaWorld()
    const held = await world.held()

    expect(await world.paymentFailed(held)).toBe('applied')

    expect(await world.booking(held.id)).toMatchObject({
      status: 'CANCELLED',
      cancellation: 'payment_failed',
    })
    expect(world.holds.held(slotOf(held))).toBe(0)
    expect(await world.saga(held.id)).toMatchObject({ phase: 'compensated' })
    expect(world.sent(held.id)).not.toContain('payment.refund')
    expect(world.sent(held.id).at(-1)).toBe('booking.cancelled')
  })

  test('pembayaran gagal untuk pemesanan yang sudah dibayar tidak mengubah apa pun', async () => {
    const world = sagaWorld()
    const paid = await world.paid()

    expect(await world.paymentFailed(paid)).toBe('ignored')
    expect(await world.booking(paid.id)).toMatchObject({ status: 'PAID' })
  })
})

describe('US-05: status supplier tidak dapat dipastikan', () => {
  test('jawaban uncertain: NEEDS_REVIEW TANPA refund, dengan galat tingkat error', async () => {
    const world = sagaWorld()
    const paid = await world.paid()

    expect(await world.supplierUncertain(paid)).toBe('applied')

    expect(await world.booking(paid.id)).toMatchObject({
      status: 'NEEDS_REVIEW',
      review: { from: 'PAID' },
    })
    expect(world.sent(paid.id)).not.toContain('payment.refund')
    expect(await world.saga(paid.id)).toMatchObject({ phase: 'review', compensation: 'skipped' })
    expect(world.logs().some((entry) => entry.level === ERROR_LEVEL)).toBe(true)
  })

  test('tidak ada jawaban sampai batas waktu: NEEDS_REVIEW, BUKAN refund', async () => {
    // Timeout bukan penolakan. Supplier mungkin sudah membuat pemesanannya.
    const world = sagaWorld()
    const paid = await world.paid()
    world.advance(SAGA_POLICY.confirmTimeoutMs)

    const report = await sweepSagas(world.deps)

    expect(report.timedOut).toBe(1)
    expect(await world.booking(paid.id)).toMatchObject({ status: 'NEEDS_REVIEW' })
    expect(world.sent(paid.id)).not.toContain('payment.refund')
    const failed = world.outbox().filter((row) => row.messageType === 'booking.failed')
    expect(failed.at(-1)?.payload).toMatchObject({ requiresManualReview: true })
  })

  test('sebelum batas waktu, penyapu tidak menyentuh saga yang menunggu', async () => {
    const world = sagaWorld()
    const paid = await world.paid()
    world.advance(SAGA_POLICY.confirmTimeoutMs - 1)

    expect(await sweepSagas(world.deps)).toEqual({ timedOut: 0, recovered: 0, failed: 0 })
    expect(await world.booking(paid.id)).toMatchObject({ status: 'PAID' })
  })
})

describe('kompensasi gagal', () => {
  test('refund tidak terkonfirmasi sampai batas waktu: NEEDS_REVIEW dengan galat tingkat error', async () => {
    const world = sagaWorld()
    const paid = await world.paid()
    await world.supplierRejected(paid)
    world.advance(SAGA_POLICY.awaitRefundTimeoutMs)

    await sweepSagas(world.deps)

    expect(await world.booking(paid.id)).toMatchObject({
      status: 'NEEDS_REVIEW',
      review: { from: 'FAILED' },
    })
    expect(await world.saga(paid.id)).toMatchObject({ phase: 'review', compensation: 'failed' })
    const errors = world.logs().filter((entry) => entry.level === ERROR_LEVEL)
    expect(errors.map((entry) => entry.msg)).toContain(
      'refund tidak terkonfirmasi dalam batas waktu; kompensasi gagal',
    )
  })

  test('refund yang tiba setelah peninjauan tidak memindahkan pemesanan final', async () => {
    const world = sagaWorld()
    const paid = await world.paid()
    await world.supplierRejected(paid)
    world.advance(SAGA_POLICY.awaitRefundTimeoutMs)
    await sweepSagas(world.deps)

    expect(await world.paymentRefunded(paid)).toBe('ignored')
    expect(await world.booking(paid.id)).toMatchObject({ status: 'NEEDS_REVIEW' })
  })
})
