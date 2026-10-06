import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { outboxCount } from '../harness/db.js'
import { assertInvariants } from '../harness/invariants.js'
import { held, pay, waitForStatus } from '../harness/journey.js'
import { startSystem, type System } from '../harness/system.js'

/**
 * Skenario 3, 4, dan 5 — US-05: `book` kehabisan waktu, dan sistem TIDAK TAHU
 * apakah kamar terpesan.
 *
 * Ketiganya dibedakan oleh satu hal: apa yang sebenarnya terjadi di supplier.
 * mock-supplier dijadwalkan per operasi (Step 20), jadi setiap kemungkinan
 * dapat dibuat terjadi dengan pasti — tidak dengan peluang.
 *
 * Batas waktu `book` supplier-service 15 detik (DEFAULT_TIMEOUTS Step 10) dan
 * `getBooking` 8 detik. Uji ini benar-benar menunggu keduanya: memendekkannya
 * khusus untuk uji berarti menguji batas waktu yang tidak dipakai produksi.
 */

let system: System

beforeAll(async () => {
  system = await startSystem()
})

afterAll(async () => {
  await system.stop()
})

afterEach(async (context) => {
  if (context.task.result?.state === 'fail') await system.dumpLogs(context.task.name)
  await system.reset()
})

describe('timeout pada konfirmasi supplier', () => {
  test('pemesanan ternyata ada: diadopsi, CONFIRMED, tanpa pemesanan ganda', async () => {
    const journey = await held(system)
    // Supplier MENYIMPAN pemesanan, lalu jawabannya hilang.
    await system.supplier.schedule('SKY', { operation: 'book', mode: 'lose_response' })

    await pay(system, journey)
    const final = await waitForStatus(system, journey, 'CONFIRMED', 90_000)

    const { bookings } = await system.supplier.reservations()
    const mine = bookings.filter((booking) => booking.idempotencyKey === journey.bookingId)
    expect(mine).toHaveLength(1)
    expect(final.supplierRef).toBe(mine[0]?.ref)
    // Jalur adopsi yang ditempuh, bukan kebetulan `book` kedua yang berhasil.
    expect(
      system.supplierService.logs.some(
        (line) => line.raw.bookingId === journey.bookingId && line.raw.adopted === true,
      ),
    ).toBe(true)

    await assertInvariants(system, [journey.bookingId])
  })

  test('pemesanan ternyata tidak ada: book dikirim ulang dengan benar, CONFIRMED', async () => {
    const journey = await held(system)
    // Permintaan ditahan SEBELUM penangan — tidak ada yang tersimpan.
    await system.supplier.schedule('SKY', { operation: 'book', mode: 'timeout' })

    await pay(system, journey)
    await waitForStatus(system, journey, 'CONFIRMED', 90_000)

    const { bookings } = await system.supplier.reservations()
    expect(bookings.filter((booking) => booking.idempotencyKey === journey.bookingId)).toHaveLength(
      1,
    )
    expect(
      system.supplierService.logs.some(
        (line) => line.raw.bookingId === journey.bookingId && line.raw.adopted === false,
      ),
    ).toBe(true)

    await assertInvariants(system, [journey.bookingId])
  })

  test('status tetap tidak dapat dipastikan: NEEDS_REVIEW, tanpa refund', async () => {
    const journey = await held(system)
    // `book` kehabisan waktu, dan pertanyaan lewat idempotency key GAGAL di
    // setiap percobaannya — tiga, sesuai DEFAULT_RETRY_POLICY supplier-service.
    // 500, bukan timeout: sama-sama "tidak tahu", tanpa menunggu 3 × 8 detik.
    await system.supplier.schedule('SKY', { operation: 'book', mode: 'timeout' })
    await system.supplier.schedule('SKY', { operation: 'lookup', mode: 'server_error', times: 3 })

    await pay(system, journey)
    const final = await waitForStatus(system, journey, 'NEEDS_REVIEW', 90_000)

    // US-05: refund membabi buta ditolak. Tidak ada perintah refund yang
    // pernah ditulis, dan payment-service tidak pernah menghubungi penyedia.
    expect(final.refund).toBe('review')
    expect(await outboxCount(system.db.booking, journey.bookingId, 'payment.refund')).toBe(0)
    expect(system.midtrans.refunds).toHaveLength(0)

    await assertInvariants(system, [journey.bookingId])
  })
})
