import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { bookingRow, sagaRow } from '../harness/db.js'
import { assertInvariants } from '../harness/invariants.js'
import {
  bookingStatus,
  held,
  pay,
  paymentIntent,
  placeHold,
  priceChecked,
  settle,
  waitForStatus,
} from '../harness/journey.js'
import { startSystem, type System } from '../harness/system.js'
import { waitFor } from '../harness/waits.js'

/**
 * Skenario 9 — booking-service DIBUNUH di tengah saga (SIGKILL pada proses OS
 * sungguhan), lalu dinyalakan lagi di atas basis data, Redis, dan broker yang
 * sama.
 *
 * Inilah yang di Step 19 baru terbukti dengan "galat yang tidak ditangkap":
 * proses yang hilang di sini tidak menjalankan satu baris pun kode
 * penutupan — tidak ada finally, tidak ada rollback dari aplikasi, koneksi
 * Postgres dan Redis putus begitu saja, dan offset Kafka yang belum di-commit
 * tetap belum di-commit.
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

describe('proses mati di tengah langkah langsung', () => {
  test('mati saat menunggu hold supplier: dikompensasi setelah sewa habis, lalu hold ulang sampai CONFIRMED', async () => {
    const journey = await priceChecked(system)
    // Hold supplier menggantung sampai klien menyerah — jendela yang cukup
    // lebar untuk membunuh proses TEPAT di tengah langkah holdSupplier.
    await system.supplier.schedule('SKY', { operation: 'hold', mode: 'timeout' })

    const inFlight = placeHold(system, journey).catch((error: unknown) => error)
    // Niat langkah dicatat SEBELUM supplier dihubungi (Step 19). Proses
    // dibunuh setelah catatan itu ada, bukan setelah jeda tebakan.
    await waitFor(
      'saga mencatat niat holdSupplier',
      async () => await sagaRow(system.db.booking, journey.bookingId),
      (saga) => saga?.step === 'holdSupplier' && saga.stepStatus === 'started',
    )
    await system.killBooking()
    await inFlight

    await system.restartBooking()
    // Pemulihan menunggu SEWA langkah itu habis (SAGA_STEP_LEASE_MS), bukan
    // "semua yang tertinggal saat startup" — instance lain mungkin masih
    // mengerjakannya (NFR-20).
    const recovered = await waitFor(
      'saga dipulihkan: langkah holdSupplier dikompensasi',
      async () => await bookingStatus(system, journey),
      (view) => view.saga?.phase === 'compensated',
      60_000,
    )

    // Langkah yang hasilnya tidak diketahui DIKOMPENSASI, bukan diulang: hold
    // supplier tidak idempoten, dan mengulangnya menahan unit kedua
    // (saga-definition.ts). Kursi lokal kembali; tidak ada uang yang ditagih.
    expect(recovered.saga?.step).toBe('holdSupplier')
    expect(recovered.status).toBe('PRICE_CHECKED')
    expect((await bookingRow(system.db.booking, journey.bookingId))?.paymentId).toBeNull()

    // PRICE_CHECKED bukan keadaan final: hold dimulai PENGGUNA, dan saga tidak
    // mengambil kursi atas nama pengguna yang sudah pergi (Step 19). Pengguna
    // yang mengulang hold-nya melanjutkan saga yang sama sampai tuntas —
    // persis uji unit recovery.test.ts, kini di atas proses sungguhan.
    await held(system, journey)
    await pay(system, journey)
    await waitForStatus(system, journey, 'CONFIRMED', 90_000)

    await assertInvariants(system, [journey.bookingId])
  })
})

describe('proses mati saat menunggu pembayaran', () => {
  test('payment.succeeded yang terbit selama proses mati dikerjakan setelah menyala: CONFIRMED', async () => {
    const journey = await held(system)
    // Niat pembayaran dibuat SEBELUM proses dibunuh, seperti pengguna yang
    // sudah berada di halaman pembayaran. payment-service baru mengenal harga
    // yang disetujui setelah peristiwa pemesanan tiba lewat outbox; versi
    // pertama membunuh proses lebih dulu, dan bila penerbit outbox belum
    // sempat berjalan, payment-service masih memegang harga price check
    // pertama dan menolak dengan 409 — kegagalan urutan uji, bukan sistem.
    const paymentId = await paymentIntent(system, journey)
    await system.killBooking()

    // Pembayaran berhasil SELAGI booking-service tidak ada. Peristiwanya
    // menunggu di Kafka, offset consumer group belum bergerak.
    await settle(system, paymentId)

    await system.restartBooking()
    await waitForStatus(system, journey, 'CONFIRMED', 90_000)

    await assertInvariants(system, [journey.bookingId])
  })
})
