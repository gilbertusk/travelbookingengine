import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { outboxCount, statusesOf } from '../harness/db.js'
import type { InfraControl } from '../harness/infra-control.js'
import { assertInvariants } from '../harness/invariants.js'
import { pay } from '../harness/journey.js'
import type { System } from '../harness/system.js'
import { waitFor } from '../harness/waits.js'
import {
  allFinal,
  countByStatus,
  heldLoad,
  paymentIntents,
  record,
  settleAll,
  startChaosSystem,
  stopwatch,
} from './support.js'

/**
 * Chaos 1 dan 2 — supplier mati pada dua saat terburuk (Step 28).
 *
 * Supplier yang mati di sini adalah KONTAINER mock-supplier yang dihentikan
 * (koneksi ditolak di tingkat TCP) dan jawaban `book` yang hilang SETELAH
 * pemesanan tersimpan — dua kegagalan yang dibedakan Step 20 karena artinya
 * berbeda: yang pertama kepastian bahwa tidak ada yang tersimpan, yang kedua
 * ketidakpastian.
 */

const LOAD = 4
let system: System
let infra: InfraControl

beforeAll(async () => {
  ;({ system, infra } = await startChaosSystem())
})

afterAll(async () => {
  await system.stop()
})

afterEach(async (context) => {
  if (context.task.result?.state === 'fail') await system.dumpLogs(context.task.name)
  await infra.restoreAll()
  await system.reset()
})

async function pause(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

describe('chaos supplier', () => {
  test('1. supplier mati tepat setelah pembayaran berhasil, sebelum konfirmasi', async () => {
    const journeys = await heldLoad(system, LOAD)
    const ids = journeys.map((journey) => journey.bookingId)
    const payments = await paymentIntents(system, journeys)

    // Saat terburuk: uang sudah diterima penyedia, kamar belum dikonfirmasi.
    await system.supplier.stopContainer()
    await settleAll(system, payments)
    await waitFor(
      'seluruh pembayaran tercatat: PAID, menunggu supplier',
      async () => await statusesOf(system.db.booking, ids),
      (statuses) => ids.every((id) => statuses.get(id) === 'PAID'),
      60_000,
    )
    // Melewati dua jenjang retry pertama perintah konfirmasi (5 dan 30 detik).
    await pause(45_000)
    await system.supplier.startContainer()
    const elapsed = stopwatch()

    const statuses = await allFinal(system, journeys, 300_000)
    const recoveryMs = elapsed()
    await assertInvariants(system, ids)

    // Tidak satu pun berhenti di PAID: uang pengguna tidak pernah ditinggal
    // tanpa kamar atau refund (M6).
    expect([...statuses.values()].every((status) => status !== 'PAID')).toBe(true)
    await record({
      id: 'supplier-down-after-payment',
      title: 'Supplier mati tepat setelah pembayaran berhasil, sebelum konfirmasi',
      fault: 'kontainer mock-supplier dihentikan setelah niat pembayaran dibuat, 45 detik',
      bookings: LOAD,
      statuses: countByStatus(statuses),
      recoveryMs,
      notes: [
        `refund ke penyedia: ${String(system.midtrans.refunds.length)}`,
        'mock-supplier menyimpan hold di memori; kontainer yang dinyalakan ulang kehilangannya',
      ],
    })
  })

  test('2. supplier mati tepat setelah konfirmasi berhasil, sebelum respons diterima', async () => {
    // (a) Jawaban `book` hilang, tetapi supplier dapat ditanya: diadopsi.
    const adopted = await heldLoad(system, 2)
    await system.supplier.schedule('SKY', { operation: 'book', mode: 'lose_response', times: 2 })
    await Promise.all(adopted.map(async (journey) => await pay(system, journey)))
    const adoptedStatuses = await allFinal(system, adopted, 180_000)

    // (b) Jawaban `book` hilang, DAN pertanyaan lewat idempotency key gagal di
    // setiap percobaannya (tiga per pemesanan): status tidak dapat dipastikan.
    const uncertain = await heldLoad(system, 2)
    await system.supplier.schedule('SKY', { operation: 'book', mode: 'lose_response', times: 2 })
    await system.supplier.schedule('SKY', { operation: 'lookup', mode: 'server_error', times: 6 })
    await Promise.all(uncertain.map(async (journey) => await pay(system, journey)))
    const uncertainStatuses = await allFinal(system, uncertain, 180_000)

    const ids = [...adopted, ...uncertain].map((journey) => journey.bookingId)
    await assertInvariants(system, ids)

    expect([...adoptedStatuses.values()]).toEqual(['CONFIRMED', 'CONFIRMED'])
    // US-05: pemesanan SUDAH ada di supplier, tetapi sistem tidak tahu.
    // Refund membabi buta di sini adalah kamar yang dibayar supplier tanpa
    // tamu. Yang benar: berhenti di depan manusia, tanpa refund.
    expect([...uncertainStatuses.values()]).toEqual(['NEEDS_REVIEW', 'NEEDS_REVIEW'])
    for (const journey of uncertain) {
      expect(await outboxCount(system.db.booking, journey.bookingId, 'payment.refund')).toBe(0)
    }
    const { bookings } = await system.supplier.reservations()
    for (const id of ids) {
      expect(bookings.filter((booking) => booking.idempotencyKey === id)).toHaveLength(1)
    }

    await record({
      id: 'supplier-lost-confirm-response',
      title: 'Supplier mati tepat setelah konfirmasi berhasil, sebelum respons diterima',
      fault: 'jawaban `book` dibuang setelah pemesanan tersimpan; pada (b) `lookup` juga gagal',
      bookings: ids.length,
      statuses: countByStatus(new Map([...adoptedStatuses, ...uncertainStatuses])),
      recoveryMs: null,
      notes: [
        '(a) diadopsi lewat findBookingByIdempotencyKey: CONFIRMED, satu pemesanan supplier',
        '(b) tidak dapat dipastikan: NEEDS_REVIEW, nol perintah refund, pemesanan supplier tetap satu',
      ],
    })
  })
})
