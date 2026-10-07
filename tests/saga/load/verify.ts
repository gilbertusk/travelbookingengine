import { Redis } from 'ioredis'
import { orphanHolds } from '../harness/invariants.js'
import type { System } from '../harness/system.js'
import { eventually } from '../harness/waits.js'

/**
 * Pemeriksaan setelah uji beban (Step 22, bagian 2) — langsung ke basis data,
 * Redis, dan mock-supplier. k6 hanya tahu jawaban HTTP; yang dibuktikan di
 * sini keadaan yang tersisa setelah seluruh saga tuntas.
 *
 * Setiap invarian menghasilkan baris laporan, lulus atau tidak, lalu
 * `assertReport` melempar bila SATU saja gagal. Laporannya ditulis lebih dulu
 * supaya pelanggaran tetap terbaca beserta angkanya, bukan hanya "gagal".
 */

export interface Check {
  readonly name: string
  readonly ok: boolean
  readonly detail: string
}

export interface VerifyOptions {
  /** Ketersediaan awal yang diperebutkan. Bila diisi, CONFIRMED harus sama persis. */
  readonly expectedConfirmed?: number
  /** Batas menunggu kunci hold lokal kedaluwarsa sendiri. */
  readonly holdTtlMs: number
}

export async function verifyRun(system: System, options: VerifyOptions): Promise<readonly Check[]> {
  const db = system.db.booking
  const counts = await statusCounts(system)
  const confirmed = counts.get('CONFIRMED') ?? 0
  const checks: Check[] = []

  if (options.expectedConfirmed !== undefined) {
    checks.push({
      name: 'M5: CONFIRMED sama dengan ketersediaan awal',
      ok: confirmed === options.expectedConfirmed,
      detail: `${String(confirmed)} CONFIRMED, ketersediaan ${String(options.expectedConfirmed)}`,
    })
  }

  const duplicateRefs = await db.query<{ supplier_ref: string; count: string }>(
    `SELECT supplier_ref, count(*) AS count FROM bookings
      WHERE supplier_ref IS NOT NULL GROUP BY supplier_ref HAVING count(*) > 1`,
  )
  checks.push({
    name: 'Tidak ada booking reference supplier yang ganda',
    ok: duplicateRefs.rows.length === 0,
    detail:
      duplicateRefs.rows.length === 0
        ? 'nol ganda'
        : duplicateRefs.rows.map((row) => `${row.supplier_ref}×${row.count}`).join(', '),
  })

  checks.push(await moneySettled(system))

  const stranded = await db.query<{ status: string; count: string }>(
    `SELECT status, count(*) AS count FROM bookings
      WHERE status IN ('HELD', 'PAID', 'FAILED') GROUP BY status`,
  )
  // Namanya menyebut APA yang diperiksa. Versi pertama bernama "tidak ada
  // pemesanan tertinggal di keadaan tidak final" dan tetap lulus dengan 62
  // DRAFT dan 990 PRICE_CHECKED di tabel — keduanya memang bukan keadaan
  // final. Yang dijamin di sini lebih sempit dan lebih penting: tidak ada
  // pemesanan yang berhenti sambil MEMEGANG kamar atau uang. Pemesanan
  // pra-hold tidak memegang apa pun; jumlahnya dilaporkan, tidak disembunyikan.
  const preHold = (counts.get('DRAFT') ?? 0) + (counts.get('PRICE_CHECKED') ?? 0)
  checks.push({
    name: 'Tidak ada pemesanan berhenti sambil memegang kamar atau uang',
    ok: stranded.rows.length === 0,
    detail:
      (stranded.rows.length === 0
        ? 'nol HELD, PAID, atau FAILED'
        : stranded.rows.map((row) => `${row.status}: ${row.count}`).join(', ')) +
      `; ${String(preHold)} pra-hold (DRAFT/PRICE_CHECKED) tidak dibersihkan siapa pun`,
  })

  checks.push(await noOrphanHolds(system, options.holdTtlMs))
  checks.push(await supplierMatches(system, confirmed))

  return checks
}

/**
 * M6: setiap pembayaran berhasil berakhir terkonfirmasi atau direfund.
 *
 * NEEDS_REVIEW dihitung TERPISAH, bukan disembunyikan: uang di sana dipegang
 * manusia, sah menurut NFR-06 dan US-05, tetapi belum memenuhi M6 secara
 * ketat sampai rekonsiliasi Step 28 menyelesaikannya. Yang gagal adalah
 * pembayaran pada pemesanan yang bukan CONFIRMED, bukan NEEDS_REVIEW, dan
 * tidak punya refund berhasil.
 */
async function moneySettled(system: System): Promise<Check> {
  const payments = await system.db.payment.query<{ id: string; booking_id: string }>(
    `SELECT id, booking_id FROM payments WHERE status IN ('SUCCEEDED', 'REFUNDED', 'PARTIALLY_REFUNDED')`,
  )
  const refunded = await system.db.payment.query<{ payment_id: string }>(
    `SELECT DISTINCT payment_id FROM refunds WHERE status = 'SUCCEEDED'`,
  )
  const refundedIds = new Set(refunded.rows.map((row) => row.payment_id))
  const statuses = await system.db.booking.query<{ id: string; status: string }>(
    'SELECT id, status FROM bookings WHERE id = ANY($1::uuid[])',
    [payments.rows.map((row) => row.booking_id)],
  )
  const statusOf = new Map(statuses.rows.map((row) => [row.id, row.status]))

  let review = 0
  const unsettled: string[] = []
  for (const payment of payments.rows) {
    const status = statusOf.get(payment.booking_id)
    if (status === 'CONFIRMED' || refundedIds.has(payment.id)) continue
    if (status === 'NEEDS_REVIEW') {
      review += 1
      continue
    }
    unsettled.push(`${payment.id}:${String(status)}`)
  }

  return {
    name: 'M6: setiap pembayaran berhasil berakhir terkonfirmasi atau direfund',
    ok: unsettled.length === 0,
    detail:
      `${String(payments.rows.length)} pembayaran berhasil, ${String(refundedIds.size)} direfund, ` +
      `${String(review)} ditinjau manusia` +
      (unsettled.length === 0 ? '' : `; TANPA AKHIR: ${unsettled.slice(0, 10).join(', ')}`),
  }
}

async function noOrphanHolds(system: System, holdTtlMs: number): Promise<Check> {
  const redis = new Redis(system.infra.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 })
  await redis.connect()
  try {
    await eventually(
      'kunci hold lokal dan hold supplier habis',
      async () => (await orphanHolds(system, redis)).length === 0,
      holdTtlMs + 20_000,
    )
    return { name: 'Tidak ada hold yatim di Redis maupun di supplier', ok: true, detail: 'nol' }
  } catch {
    const orphans = await orphanHolds(system, redis)
    return {
      name: 'Tidak ada hold yatim di Redis maupun di supplier',
      ok: false,
      detail: `${String(orphans.length)} yatim: ${orphans.slice(0, 10).join(', ')}`,
    }
  } finally {
    redis.disconnect()
  }
}

/**
 * Pemesanan di mock-supplier sama dengan CONFIRMED di sistem kita — dan
 * pemesanannya SAMA, bukan hanya jumlahnya. Pemesanan supplier yang tidak
 * dikenal sistem kita adalah pemesanan bayangan: kamar yang terjual tanpa ada
 * yang tahu.
 */
async function supplierMatches(system: System, confirmed: number): Promise<Check> {
  const { bookings } = await system.supplier.reservations()
  const live = bookings.filter((booking) => booking.status === 'CONFIRMED')
  const ours = await system.db.booking.query<{ id: string; supplier_ref: string }>(
    `SELECT id, supplier_ref FROM bookings WHERE status = 'CONFIRMED'`,
  )
  const ourRefs = new Set(ours.rows.map((row) => row.supplier_ref))
  const shadows = live.filter((booking) => !ourRefs.has(booking.ref))
  const missing = ours.rows.filter(
    (row) => !live.some((booking) => booking.ref === row.supplier_ref),
  )

  return {
    name: 'Pemesanan di mock-supplier cocok dengan CONFIRMED',
    ok: live.length === confirmed && shadows.length === 0 && missing.length === 0,
    detail:
      `supplier ${String(live.length)}, kita ${String(confirmed)}` +
      (shadows.length === 0
        ? ''
        : `; bayangan: ${shadows.map((b) => b.idempotencyKey).join(', ')}`) +
      (missing.length === 0
        ? ''
        : `; hilang di supplier: ${missing.map((row) => row.id).join(', ')}`),
  }
}

export async function statusCounts(system: System): Promise<ReadonlyMap<string, number>> {
  const result = await system.db.booking.query<{ status: string; count: string }>(
    'SELECT status, count(*) AS count FROM bookings GROUP BY status',
  )
  return new Map(result.rows.map((row) => [row.status, Number(row.count)]))
}

export function assertReport(checks: readonly Check[]): void {
  const failed = checks.filter((check) => !check.ok)
  if (failed.length > 0) {
    throw new Error(
      `${String(failed.length)} invarian dilanggar:\n` +
        failed.map((check) => `  ✗ ${check.name} — ${check.detail}`).join('\n'),
    )
  }
}
