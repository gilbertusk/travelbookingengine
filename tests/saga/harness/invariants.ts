import { Redis } from 'ioredis'
import { expect } from 'vitest'
import {
  bookingEvents,
  bookingRow,
  refundsOf,
  statusesOf,
  succeededPayments,
  type BookingRow,
} from './db.js'
import type { System } from './system.js'
import { eventually } from './waits.js'

/**
 * Invarian yang WAJIB benar setelah setiap skenario (Step 20, bagian 4).
 *
 * Dipanggil di akhir setiap uji, bukan hanya di skenario yang "menyangkut"
 * invariannya: pelanggaran yang paling berbahaya adalah yang muncul di
 * skenario yang tidak sedang memikirkannya — pembayaran yatim dari uji hold
 * yang kedaluwarsa, hold supplier yang tertinggal dari uji alur bahagia.
 *
 * Invarian pembayaran diperiksa atas SELURUH basis data, bukan hanya
 * pemesanan uji ini; sisanya atas pemesanan yang disebut uji.
 */

export const FINAL_STATUSES = ['CONFIRMED', 'REFUNDED', 'CANCELLED', 'EXPIRED', 'NEEDS_REVIEW']

/**
 * Peristiwa yang WAJIB menjadi jejak terakhir untuk setiap keadaan final.
 * Jejak yang berhenti di peristiwa lain berarti keadaan diubah tanpa lewat
 * transisi domain.
 */
const FINAL_EVENT: Readonly<Record<string, string>> = {
  CONFIRMED: 'BookingConfirmed',
  REFUNDED: 'BookingRefunded',
  CANCELLED: 'BookingCancelled',
  EXPIRED: 'HoldExpired',
  NEEDS_REVIEW: 'ReviewRequired',
}

/** booking-service: kunci waktu per hold, `booking:hold:lock:<id>` (redis-hold-store.ts). */
const LOCK_PREFIX = 'booking:hold:lock:'

/** Keadaan yang sah memegang hold — lokal maupun di supplier. */
const HOLDING_STATUSES = new Set(['HELD', 'PAID'])

export async function assertInvariants(
  system: System,
  bookingIds: readonly string[],
): Promise<void> {
  const rows = await Promise.all(
    bookingIds.map(async (id) => await bookingRow(system.db.booking, id)),
  )

  for (const [index, row] of rows.entries()) {
    expect(row, `pemesanan ${String(bookingIds[index])} ada`).toBeDefined()
    if (row === undefined) return
    assertFinal(row)
    await assertEventTrail(system, row)
    await assertOutboxDrained(system, row.id)
    await assertSingleSupplierBooking(system, row)
  }

  await assertPaymentsSettled(system)
  await assertNoOrphanHolds(system, system.infra.mockSupplier.holdTtlMs)
}

/** 1. Tidak ada pemesanan di keadaan tidak final setelah saga selesai. */
function assertFinal(row: BookingRow): void {
  expect(FINAL_STATUSES, `pemesanan ${row.id} final (sekarang ${row.status})`).toContain(row.status)
}

/**
 * 4. Jumlah booking_events konsisten dengan keadaan akhir: satu peristiwa per
 *    versi, tanpa lubang, dan yang terakhir adalah peristiwa keadaan akhirnya.
 */
async function assertEventTrail(system: System, row: BookingRow): Promise<void> {
  const events = await bookingEvents(system.db.booking, row.id)

  // Pesan kegagalannya menyebut JEJAKNYA, bukan hanya nomor urut. Nomor yang
  // hilang hanya memberi tahu ada lubang; jejak berisi jenis peristiwa
  // memberi tahu transisi MANA yang tidak tercatat — dan itulah yang
  // membedakan cacat di sistem dari cacat di invarian ini. Versi pertama
  // hanya mencetak angka, dan menemukan penyebabnya memakan empat kali
  // jalan ulang yang masing-masing empat menit.
  const trail = events.map((event) => `${String(event.sequence)}:${event.type}`).join(' → ')

  expect(
    events.map((event) => event.sequence),
    `urutan jejak ${row.id} tanpa lubang — ${trail}`,
  ).toEqual(Array.from({ length: events.length }, (_, index) => index + 1))

  expect(
    events.length,
    `jejak ${row.id} selengkap versinya (status ${row.status}, version ${String(row.version)}) — ${trail}`,
  ).toBe(row.version)

  expect(events.at(-1)?.type, `peristiwa terakhir ${row.id}`).toBe(FINAL_EVENT[row.status])
  expect(
    events.filter((event) => event.type === FINAL_EVENT[row.status]),
    `tepat satu ${String(FINAL_EVENT[row.status])} untuk ${row.id}`,
  ).toHaveLength(1)
}

/** Seluruh pesan outbox pemesanan ini sudah terbit — tidak ada perintah yang tertahan. */
async function assertOutboxDrained(system: System, bookingId: string): Promise<void> {
  await eventually(`outbox ${bookingId} terkuras`, async () => {
    const result = await system.db.booking.query<{ count: string }>(
      `SELECT count(*) AS count FROM outbox
        WHERE booking_id = $1 AND published_at IS NULL AND rejected_at IS NULL`,
      [bookingId],
    )
    return Number(result.rows[0]?.count ?? 0) === 0
  })
}

/**
 * Tidak ada pemesanan ganda di supplier: paling banyak SATU pemesanan per
 * kunci idempotensi (= id pemesanan), dan pemesanan CONFIRMED menunjuk
 * pemesanan supplier yang terkonfirmasi itu.
 */
async function assertSingleSupplierBooking(system: System, row: BookingRow): Promise<void> {
  const { bookings } = await system.supplier.reservations()
  const mine = bookings.filter((booking) => booking.idempotencyKey === row.id)

  expect(mine.length, `paling banyak satu pemesanan supplier untuk ${row.id}`).toBeLessThanOrEqual(
    1,
  )
  if (row.status === 'CONFIRMED') {
    expect(mine[0]?.status, `pemesanan supplier ${row.id} terkonfirmasi`).toBe('CONFIRMED')
    expect(row.supplierRef).toBe(mine[0]?.ref)
  }
}

/**
 * 2. Tidak ada pembayaran berhasil tanpa pemesanan terkonfirmasi atau refund.
 *
 * Satu pengecualian yang disengaja, dan ia bukan celah: NEEDS_REVIEW. NFR-06
 * menyebut tiga akhir yang sah — terkonfirmasi, dana kembali, atau ditandai
 * untuk peninjauan manual — dan US-05 justru MELARANG refund otomatis ketika
 * status supplier tidak pasti. Pembayaran pada pemesanan yang ditinjau adalah
 * uang yang sedang dipegang manusia, bukan uang yang terlupa.
 */
async function assertPaymentsSettled(system: System): Promise<void> {
  const payments = await succeededPayments(system.db.payment)
  const statuses = await statusesOf(
    system.db.booking,
    payments.map((payment) => payment.bookingId),
  )

  for (const payment of payments) {
    const status = statuses.get(payment.bookingId)
    if (status === 'CONFIRMED' || status === 'NEEDS_REVIEW') continue
    // Pemesanan yang BELUM final sedang di tengah saga — PAID menunggu
    // supplier adalah keadaan sah. Pemesanan uji ini sendiri sudah dituntut
    // final oleh invarian 1; yang dilewati di sini hanya saga milik uji lain
    // yang masih berjalan. Versi pertama tidak melewatinya: pada putaran
    // ketiga Step 20, pemesanan PAID yang ditinggalkan berkas lain yang gagal
    // ikut menggagalkan skenario yang tidak ada hubungannya.
    if (status !== undefined && !FINAL_STATUSES.includes(status)) continue

    const refunds = await refundsOf(system.db.payment, payment.id)
    expect(
      refunds.filter((refund) => refund.status !== 'FAILED'),
      `pembayaran ${payment.id} (pemesanan ${String(status)}) punya refund`,
    ).not.toHaveLength(0)
    if (status === 'REFUNDED') {
      expect(refunds.map((refund) => refund.status)).toContain('SUCCEEDED')
    }
  }
}

/**
 * 3. Tidak ada hold yatim, di Redis maupun di supplier.
 *
 * Yatim = hold yang dipegang pemesanan yang TIDAK lagi sedang memegangnya
 * (bukan HELD atau PAID), atau pemesanan yang tidak dikenal sama sekali —
 * proses yang mati di antara mengambil hold dan menyimpannya.
 *
 * Hold seperti itu boleh ada SESAAT: hold supplier tidak dilepas aktif (Step
 * 19 memutuskan kompensasinya `lapses`), dan kursi lokal pemesanan yang
 * terkonfirmasi dilepas penyapu saat kunci waktunya habis. Karena itu yang
 * dituntut adalah semuanya HILANG dalam umur hold ditambah satu putaran
 * penyapu — bukan seketika. Hold yang tidak pernah hilang adalah yatim.
 */
async function assertNoOrphanHolds(system: System, holdTtlMs: number): Promise<void> {
  const redis = new Redis(system.infra.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 })
  await redis.connect()
  try {
    await eventually(
      'tidak ada hold yatim di Redis maupun di supplier',
      async () => (await orphanHolds(system, redis)).length === 0,
      holdTtlMs + 15_000,
    )
  } catch (error) {
    const orphans = await orphanHolds(system, redis)
    throw new Error(`${String(error)}\nyatim: ${JSON.stringify(orphans)}`, { cause: error })
  } finally {
    redis.disconnect()
  }
}

async function orphanHolds(system: System, redis: Redis): Promise<readonly string[]> {
  const seats = await localSeats(redis)
  const { holds } = await system.supplier.reservations()
  const supplierOwners = await ownersOfSupplierHolds(
    system,
    holds.map((hold) => hold.ref),
  )
  const statuses = await statusesOf(system.db.booking, seats)
  const locked = await Promise.all(
    seats.map(async (id) => (await redis.exists(`${LOCK_PREFIX}${id}`)) === 1),
  )

  return [
    ...seats
      // Kursi yang kunci waktunya MASIH hidup dilepas oleh kedaluwarsanya
      // sendiri (keyspace notification, dengan penyapu sebagai jaring — Step
      // 17). Yang yatim adalah kursi tanpa kunci waktu milik pemesanan yang
      // tidak lagi memegangnya: tidak ada lagi yang akan melepasnya selain
      // penyapu yatim, dan penyapu itulah yang diuji di sini.
      .filter(
        (id, index) =>
          !HOLDING_STATUSES.has(statuses.get(id) ?? 'TIDAK_DIKENAL') && locked[index] !== true,
      )
      .map((id) => `redis:${id}:${statuses.get(id) ?? 'TIDAK_DIKENAL'}`),
    ...holds
      .filter((hold) => !HOLDING_STATUSES.has(supplierOwners.get(hold.ref) ?? 'TIDAK_DIKENAL'))
      .map((hold) => `supplier:${hold.ref}:${supplierOwners.get(hold.ref) ?? 'TIDAK_DIKENAL'}`),
  ]
}

async function localSeats(redis: Redis): Promise<readonly string[]> {
  const keys = await redis.keys('booking:hold:members:*')
  const members = await Promise.all(keys.map(async (key) => await redis.smembers(key)))
  return members.flat()
}

async function ownersOfSupplierHolds(
  system: System,
  refs: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const result = await system.db.booking.query<{ hold_ref: string; status: string }>(
    'SELECT hold_ref, status FROM bookings WHERE hold_ref = ANY($1::text[])',
    [refs],
  )
  return new Map(result.rows.map((row) => [row.hold_ref, row.status]))
}
