import {
  createEventPublisher,
  createKafkaClient,
  toProducerPort,
  type EventPublisher,
} from '@tbe/messaging'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { outboxCount } from '../harness/db.js'
import { assertInvariants } from '../harness/invariants.js'
import { bookingStatus, held, pay, waitForStatus, type Journey } from '../harness/journey.js'
import { startSystem, type System } from '../harness/system.js'
import { waitFor } from '../harness/waits.js'

/**
 * Skenario 2 dan 8 — supplier MATI tepat setelah pembayaran (US-03), dan
 * refund yang gagal berulang — ditambah kompensasi `cancelSupplierBooking`:
 * konfirmasi supplier yang tiba SETELAH dana dikembalikan.
 *
 * "Mati" di sini adalah kontainer mock-supplier yang DIHENTIKAN: koneksi
 * ditolak di tingkat TCP, satu-satunya kegagalan yang membuktikan supplier
 * tidak pernah menerima `book`. Pemutusan koneksi setelah terbentuk
 * (`/admin/down`) sejak Step 20 digolongkan TIDAK PASTI dan berakhir di
 * peninjauan, bukan refund — lihat Temuan Step 20.
 *
 * Ketiga skenario menunggu jenjang retry RabbitMQ yang sungguhan (5 s, 30 s,
 * 2 m) sampai dead letter. Ketiganya berjalan BERSAMAAN supaya menunggu sekali:
 * semuanya memakai supplier yang sama-sama mati, dan hanya jawaban penyedia
 * pembayaran atas refund yang berbeda — diatur per pembayaran di pengganti
 * Midtrans.
 */

type Producer = ReturnType<ReturnType<typeof createKafkaClient>['producer']>

/** Jenjang retry (155 s) + batas menunggu refund (200 s) + ruang. */
const SLOW_MS = 420_000

let system: System
let refunded: Journey
let stuck: Journey
let late: Journey
let producer: Producer
let events: EventPublisher

beforeAll(async () => {
  system = await startSystem()
  // Ketiga pemesanan memegang hold SEBELUM supplier mati.
  refunded = await held(system)
  stuck = await held(system)
  late = await held(system)
  producer = createKafkaClient({
    clientId: 'saga-it-late-confirmation',
    brokers: [...system.infra.kafkaBrokers],
  }).producer()
  await producer.connect()
  events = createEventPublisher(toProducerPort(producer))
  await system.supplier.stopContainer()
})

afterAll(async () => {
  await producer.disconnect()
  await system.supplier.ensureRunning()
  await system.stop()
})

describe('supplier mati setelah pembayaran', () => {
  test.concurrent(
    'konfirmasi gagal pasti → refund otomatis → REFUNDED',
    async ({ onTestFailed }) => {
      onTestFailed(async () => {
        await system.dumpLogs('supplier-mati-refunded')
      })
      const paymentId = await pay(system, refunded)
      system.midtrans.setRefundBehavior('accept', paymentId)

      const final = await waitForStatus(system, refunded, 'REFUNDED', SLOW_MS)

      expect(final.refund).toBe('completed')
      expect(
        system.midtrans.refunds.filter(
          (call) => call.orderId === paymentId && call.answeredWith === 'accept',
        ),
      ).toHaveLength(1)

      await restartSupplierWhenAllFinal()
      await assertInvariants(system, [refunded.bookingId])
    },
    SLOW_MS + 60_000,
  )

  test.concurrent(
    'refund gagal berulang → NEEDS_REVIEW dengan galat tingkat error',
    async ({ onTestFailed }) => {
      onTestFailed(async () => {
        await system.dumpLogs('refund-gagal-berulang')
      })
      const paymentId = await pay(system, stuck)
      system.midtrans.setRefundBehavior('unavailable', paymentId)

      const final = await waitForStatus(system, stuck, 'NEEDS_REVIEW', SLOW_MS)

      expect(final.refund).toBe('review')
      expect(
        system.midtrans.refunds.filter((call) => call.orderId === paymentId).length,
      ).toBeGreaterThan(1)
      // Uang pengguna tertahan: kedua sisi mencatatnya sebagai GALAT, bukan
      // peringatan — peringatan tidak menuntut tindakan siapa pun.
      await waitFor(
        'booking-service mencatat galat untuk pemesanan ini',
        async () =>
          await Promise.resolve(
            system.booking.logs.filter(
              (line) => line.level === 'error' && line.raw.bookingId === stuck.bookingId,
            ).length,
          ),
        (count) => count > 0,
      )
      expect(system.payment.logs.some((line) => line.level === 'error')).toBe(true)

      await restartSupplierWhenAllFinal()
      await assertInvariants(system, [stuck.bookingId])
    },
    SLOW_MS + 60_000,
  )

  // Di describe yang SAMA dengan dua uji di atas: Vitest hanya menjalankan
  // test.concurrent bersamaan di dalam satu describe. Versi pertama berada
  // di describe sendiri, berjalan SETELAH keduanya selesai, dan hold-nya
  // sudah kedaluwarsa sebelum dibayar.
  test.concurrent(
    'konfirmasi yang tiba setelah REFUNDED → supplier.cancel sampai ke supplier, saga ke peninjauan',
    async ({ onTestFailed }) => {
      onTestFailed(async () => {
        await system.dumpLogs('konfirmasi-terlambat')
      })
      const paymentId = await pay(system, late)
      system.midtrans.setRefundBehavior('accept', paymentId)
      await waitForStatus(system, late, 'REFUNDED', SLOW_MS)
      await restartSupplierWhenAllFinal()

      // Supplier ternyata MENYIMPAN pemesanan untuk kunci ini — perintah dari
      // dead letter yang diputar ulang operator, kasus yang ditulis di
      // on-supplier.ts — lalu konfirmasinya tiba di Kafka setelah dana
      // pengguna kembali. Pemesanan itu sungguhan di mock-supplier, jadi
      // pembatalannya dibuktikan di sana, bukan hanya di outbox.
      const supplierRef = await system.supplier.bookBehindSaga(late)
      await events.publish('supplier.booking_confirmed', {
        bookingId: late.bookingId,
        supplier: 'SKY',
        supplierRef,
        adopted: false,
      })

      // Kompensasi langkah confirmSupplier dari tabel saga: kamar yang dananya
      // sudah kembali dibatalkan di supplier, lewat RabbitMQ dan
      // supplier-service yang sungguhan.
      await waitFor(
        `pemesanan supplier ${supplierRef} dibatalkan`,
        async () => await system.supplier.reservations(),
        ({ bookings }) =>
          bookings.some((booking) => booking.ref === supplierRef && booking.status === 'CANCELLED'),
        60_000,
      )
      const final = await waitFor(
        'saga diserahkan ke peninjauan',
        async () => await bookingStatus(system, late),
        (view) => view.saga?.phase === 'review',
      )
      // Dana sudah kembali: pemesanan tetap REFUNDED, tidak berubah menjadi
      // CONFIRMED oleh konfirmasi yang terlambat.
      expect(final.status).toBe('REFUNDED')
      expect(await outboxCount(system.db.booking, late.bookingId, 'supplier.cancel')).toBe(1)
      expect(
        system.booking.logs.some(
          (line) => line.level === 'error' && line.raw.bookingId === late.bookingId,
        ),
      ).toBe(true)

      await assertInvariants(system, [late.bookingId])
    },
    // Menunggu dua uji lainnya final, lalu pembatalan dan invarian hold.
    SLOW_MS + 180_000,
  )
})

/**
 * Supplier dinyalakan kembali hanya setelah KETIGA pemesanan final.
 *
 * Invarian membaca keadaan mock-supplier, jadi ia harus menyala sebelum
 * `assertInvariants`. Tetapi ketiga uji berjalan bersamaan: uji yang selesai
 * lebih dulu tidak boleh menghidupkan supplier selagi perintah konfirmasi uji
 * lainnya masih di jenjang retry — `book` berikutnya akan berhasil, dan
 * skenario "supplier mati" diam-diam berubah menjadi alur bahagia.
 */
async function restartSupplierWhenAllFinal(): Promise<void> {
  await waitFor(
    'ketiga pemesanan skenario supplier mati final',
    async () =>
      await Promise.all(
        [refunded, stuck, late].map(async (journey) => await bookingStatus(system, journey)),
      ),
    (views) => views.every((view) => view.isFinal),
    SLOW_MS,
  )
  await system.supplier.ensureRunning()
}
