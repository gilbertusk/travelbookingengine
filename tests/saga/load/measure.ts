import { writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { System } from '../harness/system.js'
import { eventually } from '../harness/waits.js'
import { stat, type K6Summary } from './k6.js'
import { statusCounts, type Check } from './verify.js'

/**
 * Pengukuran tambahan Step 22, bagian 3. Waktu antar-peristiwa dibaca dari
 * `booking_events` — jejak audit yang sama dengan yang dibaca operator — bukan
 * dari jam k6, yang tidak tahu kapan saga di belakang benar-benar selesai.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

export interface Durations {
  readonly count: number
  readonly p50Ms: number | null
  readonly p95Ms: number | null
  readonly maxMs: number | null
}

/** Selisih waktu antara dua jenis peristiwa pada pemesanan yang sama. */
export async function between(system: System, from: string, to: string): Promise<Durations> {
  const result = await system.db.booking.query<{ ms: string }>(
    `SELECT EXTRACT(EPOCH FROM (b.occurred_at - a.occurred_at)) * 1000 AS ms
       FROM booking_events a JOIN booking_events b ON a.booking_id = b.booking_id
      WHERE a.event_type = $1 AND b.event_type = $2`,
    [from, to],
  )
  const values = result.rows.map((row) => Number(row.ms)).sort((x, y) => x - y)

  return {
    count: values.length,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: values.at(-1) ?? null,
  }
}

function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null
  const index = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)
  return Math.round(sorted[index] ?? 0)
}

/** Pemesanan yang berakhir di peninjauan, dikelompokkan menurut sebabnya. */
export async function reviewReasons(system: System): Promise<Readonly<Record<string, number>>> {
  const result = await system.db.booking.query<{ reason: string | null; count: string }>(
    `SELECT review_reason AS reason, count(*) AS count FROM bookings
      WHERE status = 'NEEDS_REVIEW' GROUP BY review_reason`,
  )
  return Object.fromEntries(
    result.rows.map((row) => [row.reason ?? '(tanpa alasan)', Number(row.count)]),
  )
}

/**
 * Menunggu seluruh saga tuntas: tidak ada pemesanan di keadaan yang memegang
 * kamar atau uang, dan outbox terkuras. Polling, bukan jeda tetap.
 */
export async function waitSettled(system: System, timeoutMs: number): Promise<void> {
  await eventually(
    'seluruh pemesanan tuntas dan outbox terkuras',
    async () => {
      assertServicesAlive(system)
      const busy = await system.db.booking.query<{ count: string }>(
        `SELECT (SELECT count(*) FROM bookings WHERE status IN ('HELD', 'PAID', 'FAILED'))
              + (SELECT count(*) FROM outbox WHERE published_at IS NULL AND rejected_at IS NULL)
              AS count`,
      )
      return Number(busy.rows[0]?.count ?? 1) === 0
    },
    timeoutMs,
  )
}

/**
 * Melempar bila ada service yang mati di tengah uji beban.
 *
 * Tanpa pemeriksaan ini, service yang mati hanya terlihat sebagai "tidak
 * pernah tuntas dalam 900000 ms" lima belas menit kemudian — dan itu terbaca
 * seperti saga yang tersangkut, padahal tidak ada lagi proses yang
 * mengerjakannya. Jalan ketiga skenario supplier mati berakhir begitu:
 * booking-service keluar dengan kode 3221226505 dua belas detik setelah
 * supplier dimatikan, dan penyebab sebenarnya baru terbaca dari baris
 * terakhir log yang disimpan.
 *
 * Di produksi proses yang mati dinyalakan kembali dan saganya dipulihkan
 * (dibuktikan uji saga `crash-recovery`). Uji beban tidak menyalakan apa pun
 * kembali, jadi hasilnya setelah kematian itu bukan pengukuran sistem.
 */
export function assertServicesAlive(system: System): void {
  for (const service of [system.booking, system.payment, system.supplierService, system.pricing]) {
    const exit = service.logs.find((line) => line.level === 'exit')
    if (exit !== undefined) {
      throw new Error(`${service.name} mati di tengah uji beban — ${exit.msg}`)
    }
  }
}

export interface RunReport {
  readonly scenario: string
  readonly at: string
  readonly config: Readonly<Record<string, unknown>>
  readonly k6: Readonly<Record<string, number | undefined>>
  readonly statuses: Readonly<Record<string, number>>
  readonly paymentToConfirmation: Durations
  readonly failureToRefund: Durations
  /**
   * Dari pembayaran tercatat sampai dana kembali — penantian PENGGUNA. Jauh
   * lebih panjang dari `failureToRefund`: di antaranya perintah konfirmasi
   * dicoba sepanjang jenjang retry (5 s, 30 s, 2 m) sebelum saga menyerah.
   * Melaporkan hanya `failureToRefund` membuat refund tampak selesai dalam
   * seperdelapan detik, padahal uangnya tertahan beberapa menit.
   */
  readonly paymentToRefund: Durations
  readonly reviewReasons: Readonly<Record<string, number>>
  readonly checks: readonly Check[]
}

export interface RunInput {
  readonly scenario: string
  readonly config: Readonly<Record<string, unknown>>
  readonly summary: K6Summary
  readonly checks: readonly Check[]
}

export async function buildReport(system: System, input: RunInput): Promise<RunReport> {
  const { scenario, config, summary, checks } = input
  return {
    scenario,
    at: new Date().toISOString(),
    config,
    k6: {
      holdP95Ms: round(stat(summary, 'hold_duration', 'p(95)')),
      holdP99Ms: round(stat(summary, 'hold_duration', 'p(99)')),
      holdMaxMs: round(stat(summary, 'hold_duration', 'max')),
      held: stat(summary, 'hold_held', 'count'),
      soldOut: stat(summary, 'hold_sold_out', 'count'),
      holdOther: stat(summary, 'hold_other', 'count'),
      priceCheckFailed: stat(summary, 'price_check_failed', 'count'),
      paymentsSent: stat(summary, 'payment_sent', 'count'),
      paymentOpenRetries: stat(summary, 'payment_open_retried', 'count'),
      httpRequests: stat(summary, 'http_reqs', 'count'),
    },
    statuses: Object.fromEntries(await statusCounts(system)),
    paymentToConfirmation: await between(system, 'PaymentRecorded', 'BookingConfirmed'),
    failureToRefund: await between(system, 'BookingFailed', 'BookingRefunded'),
    paymentToRefund: await between(system, 'PaymentRecorded', 'BookingRefunded'),
    reviewReasons: await reviewReasons(system),
    checks,
  }
}

/** Laporan ke infra/k6/results/, dan ke layar. */
export async function saveReport(report: RunReport): Promise<string> {
  const stamp = report.at.replace(/[:.]/g, '-')
  const file = join(REPO_ROOT, 'infra/k6/results', `${report.scenario}-${stamp}.json`)
  await writeFile(file, JSON.stringify(report, null, 2), 'utf8')
  process.stdout.write(`\n${render(report)}\n→ ${file}\n`)
  return file
}

function render(report: RunReport): string {
  return [
    `== ${report.scenario}`,
    `status: ${JSON.stringify(report.statuses)}`,
    `k6: ${JSON.stringify(report.k6)}`,
    `bayar→konfirmasi: ${JSON.stringify(report.paymentToConfirmation)}`,
    `gagal→refund: ${JSON.stringify(report.failureToRefund)}`,
    `bayar→refund: ${JSON.stringify(report.paymentToRefund)}`,
    `ditinjau: ${JSON.stringify(report.reviewReasons)}`,
    ...report.checks.map((check) => `${check.ok ? '✓' : '✗'} ${check.name} — ${check.detail}`),
  ].join('\n')
}

function round(value: number | undefined): number | undefined {
  return value === undefined ? undefined : Math.round(value)
}
