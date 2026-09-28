import { describe, expect, test } from 'vitest'
import { crashAfterCommit, crashingHoldStore, SimulatedCrash } from '../../testing/crash.js'
import { memoryHoldStore, priceCheckRequest, SAGA_POLICY, USER } from '../../testing/fakes.js'
import { sagaWorld, type SagaWorld } from '../../testing/saga-world.js'
import { slotOf } from '../hold-slot.js'
import { placeHold } from '../place-hold.js'
import { startPriceCheck } from '../price-check.js'
import { sweepSagas } from './sweep-sagas.js'

/**
 * Uji wajib: "proses dimatikan di tengah saga lalu dihidupkan: saga dipulihkan
 * dan selesai".
 *
 * Proses mati ditiru dengan galat yang tidak ditangkap kode produksi mana pun
 * (testing/crash.ts), lalu `restart()` membangun proses BARU — dependensi
 * baru, tanpa keadaan di memori proses lama — di atas basis data dan Redis
 * yang sama. Pemulihan adalah putaran penyapu saga, yang di produksi berjalan
 * saat startup sebelum HTTP menerima permintaan, lalu berkala.
 *
 * Yang membuat pemulihan mungkin adalah catatan niat yang ditulis SEBELUM
 * langkahnya: proses yang mati setelah mengambil kursi Redis meninggalkan saga
 * "holdLocal dimulai", dan hanya catatan itu yang memberi tahu proses baru
 * bahwa ada kursi yang harus dikembalikan.
 */

async function priceChecked(world: SagaWorld) {
  const checked = await startPriceCheck(world.deps, priceCheckRequest())
  if (checked.kind !== 'checked') throw new Error('persiapan gagal')
  return checked.booking
}

async function hold(world: SagaWorld, bookingId: string) {
  return await placeHold(world.deps, { userId: USER, bookingId, unitsLeft: 5 })
}

describe('proses mati di tengah hold', () => {
  test('setelah kursi lokal diambil: dipulihkan, kursi kembali, lalu saga selesai sampai CONFIRMED', async () => {
    const world = sagaWorld({ holds: crashingHoldStore(memoryHoldStore(), 'after-acquire') })
    const booking = await priceChecked(world)
    await expect(hold(world, booking.id)).rejects.toBeInstanceOf(SimulatedCrash)
    expect(world.holds.held(slotOf(booking))).toBe(1)

    const revived = world.restart()
    revived.advance(SAGA_POLICY.leaseMs)
    const report = await sweepSagas(revived.deps)

    expect(report.recovered).toBe(1)
    expect(revived.holds.held(slotOf(booking))).toBe(0)
    expect(await revived.saga(booking.id)).toMatchObject({
      phase: 'compensated',
      step: 'holdLocal',
    })

    // Pengguna mengulang hold-nya; saga yang sama berjalan sampai selesai.
    const retried = await hold(revived, booking.id)
    expect(retried.kind).toBe('held')
    const held = await revived.booking(booking.id)
    await revived.paymentSucceeded(held)
    await revived.supplierConfirmed(held)
    expect(await revived.booking(booking.id)).toMatchObject({ status: 'CONFIRMED' })
    expect(await revived.saga(booking.id)).toMatchObject({ phase: 'completed' })
  })

  test('saga yang sewanya belum habis TIDAK diambil alih — proses lain mungkin masih mengerjakannya', async () => {
    // Beberapa instance berjalan bersamaan (NFR-20). "Tertinggal saat
    // startup" tidak berarti "ditinggalkan".
    const world = sagaWorld({ holds: crashingHoldStore(memoryHoldStore(), 'after-acquire') })
    const booking = await priceChecked(world)
    await expect(hold(world, booking.id)).rejects.toBeInstanceOf(SimulatedCrash)

    const revived = world.restart()
    revived.advance(SAGA_POLICY.leaseMs - 1)

    expect((await sweepSagas(revived.deps)).recovered).toBe(0)
    expect(revived.holds.held(slotOf(booking))).toBe(1)
    expect((await hold(revived, booking.id)).kind).toBe('in_progress')
  })

  test('setelah hold supplier terbentuk: hold lokal dilepas, hold supplier dicatat habis sendiri', async () => {
    const world = sagaWorld()
    const booking = await priceChecked(world)
    world.suppliers.nextHold(() => {
      throw new SimulatedCrash('menunggu jawaban hold supplier')
    })
    await expect(hold(world, booking.id)).rejects.toBeInstanceOf(SimulatedCrash)

    const revived = world.restart()
    revived.advance(SAGA_POLICY.leaseMs)
    await sweepSagas(revived.deps)

    // Hold supplier TIDAK diulang: operasinya tidak idempoten, dan
    // mengulangnya menahan unit kedua di supplier.
    expect(world.suppliers.holds).toHaveLength(1)
    expect(revived.holds.held(slotOf(booking))).toBe(0)
    const saga = await revived.saga(booking.id)
    expect(saga).toMatchObject({ phase: 'compensated', step: 'holdSupplier' })
    expect(saga?.lastError).toContain('holdSupplier')
  })
})

describe('proses mati di tengah kompensasi', () => {
  test('setelah FAILED tersimpan, sebelum hold lokal dilepas: dipulihkan sampai REFUNDED', async () => {
    const world = sagaWorld({
      wrapSagas: (store) =>
        crashAfterCommit(store, (unit) => unit.change?.event.type === 'BookingFailed'),
    })
    const paid = await world.paid()

    await expect(world.supplierRejected(paid)).rejects.toBeInstanceOf(SimulatedCrash)
    // Refund sudah diminta — satu transaksi dengan FAILED — walau proses mati.
    expect(await world.booking(paid.id)).toMatchObject({ status: 'FAILED' })
    expect(world.sent(paid.id)).toContain('payment.refund')
    expect(world.holds.held(slotOf(paid))).toBe(1)

    const revived = world.restart()
    revived.advance(SAGA_POLICY.leaseMs)
    expect((await sweepSagas(revived.deps)).recovered).toBe(1)
    expect(revived.holds.held(slotOf(paid))).toBe(0)

    await revived.paymentRefunded(paid)
    expect(await revived.booking(paid.id)).toMatchObject({ status: 'REFUNDED' })
    expect(await revived.saga(paid.id)).toMatchObject({ phase: 'compensated' })
  })
})

describe('proses mati sebelum efek sebuah pesan tersimpan', () => {
  test('pesan yang dibaca ulang setelah proses hidup lagi berefek tepat sekali', async () => {
    // Offset Kafka ter-commit hanya setelah handler selesai. Proses yang mati
    // di tengah transaksi membuat pesannya dibaca lagi — dengan eventId sama.
    const world = sagaWorld()
    const held = await world.held()
    const id = world.eventId('pay-crash')
    world.db.failNext('outboxMessage.create')

    await expect(world.paymentSucceeded(held, { eventId: id })).rejects.toThrow()
    expect(await world.booking(held.id)).toMatchObject({ status: 'HELD' })

    const revived = world.restart()
    expect(await revived.paymentSucceeded(held, { eventId: id })).toBe('applied')
    expect(await revived.paymentSucceeded(held, { eventId: id })).toBe('duplicate')
    expect(revived.outbox().filter((row) => row.messageType === 'supplier.confirm')).toHaveLength(1)
  })
})
