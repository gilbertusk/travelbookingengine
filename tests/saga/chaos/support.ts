import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { request } from 'undici'
import { inject } from 'vitest'
import { statusesOf } from '../harness/db.js'
import { createInfraControl, type InfraControl } from '../harness/infra-control.js'
import { FINAL_STATUSES } from '../harness/invariants.js'
import { held, paymentIntent, settle, type Journey } from '../harness/journey.js'
import { startSystem, type System } from '../harness/system.js'
import { eventually, waitFor } from '../harness/waits.js'

/**
 * Perlengkapan uji chaos (Step 28): sistem dengan trace ke Jaeger, beban
 * pemesanan normal, pengukur waktu pulih, dan pencatat laporan.
 *
 * Laporan ditulis ke tests/saga/.chaos/ — `results.jsonl` satu baris per
 * skenario yang LULUS seluruh invariannya, dan trace yang diunduh. Skenario
 * yang gagal tidak menulis baris; scripts/chaos-run.mjs mencocokkannya dengan
 * hasil vitest, jadi yang gagal tetap muncul di laporan sebagai gagal.
 */

export const CHAOS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../.chaos')

const DAY_MS = 24 * 60 * 60 * 1_000

export interface ChaosSystemOptions {
  /** Durasi hold lokal. Bawaan produksi (15 menit) kecuali skenario yang menunggu kedaluwarsa. */
  readonly holdMs?: number
}

export async function startChaosSystem(options: ChaosSystemOptions = {}): Promise<{
  system: System
  infra: InfraControl
}> {
  const jaeger = inject('jaeger')
  const system = await startSystem({
    env: {
      OTEL_ENABLED: 'true',
      OTEL_EXPORTER_OTLP_ENDPOINT: jaeger.otlpTracesUrl,
      LOG_LEVEL: 'info',
    },
    serviceEnv: {
      booking: {
        LOG_LEVEL: 'debug',
        ...(options.holdMs === undefined ? {} : { HOLD_DURATION_MS: String(options.holdMs) }),
        // Rekonsiliasi diminta skenario rekonsiliasi lewat panel, bukan
        // menunggu penjadwal: satu slot seminggu, dan masa tenggang satu detik.
        RECONCILIATION_INTERVAL_MS: String(7 * DAY_MS),
        RECONCILIATION_GRACE_MS: '1000',
      },
    },
  })
  return { system, infra: createInfraControl(system.infra) }
}

/** Beban pemesanan normal: `count` perjalanan sampai HELD, serentak. */
export async function heldLoad(system: System, count: number): Promise<Journey[]> {
  return await Promise.all(Array.from({ length: count }, async () => await held(system)))
}

/** Niat pembayaran untuk setiap perjalanan — pengguna sudah di halaman pembayaran. */
export async function paymentIntents(
  system: System,
  journeys: readonly Journey[],
): Promise<string[]> {
  return await Promise.all(journeys.map(async (journey) => await paymentIntent(system, journey)))
}

/** Notifikasi settlement untuk setiap pembayaran, serentak. */
export async function settleAll(system: System, paymentIds: readonly string[]): Promise<void> {
  await Promise.all(
    paymentIds.map(async (paymentId) => {
      await settle(system, paymentId)
    }),
  )
}

/** Mengukur sejak sekarang. */
export function stopwatch(): () => number {
  const started = Date.now()
  return () => Date.now() - started
}

/**
 * Menunggu SELURUH pemesanan mencapai keadaan final; mengembalikan keadaan
 * akhirnya. Kegagalan menyebut yang belum final — "tidak pernah final" tanpa
 * daftar adalah pesan yang memaksa membaca ulang log.
 */
export async function allFinal(
  system: System,
  journeys: readonly Journey[],
  timeoutMs: number,
): Promise<ReadonlyMap<string, string>> {
  const ids = journeys.map((journey) => journey.bookingId)
  return await waitFor(
    `seluruh ${String(ids.length)} pemesanan mencapai keadaan final`,
    async () => await statusesOf(system.db.booking, ids),
    (statuses) => ids.every((id) => FINAL_STATUSES.includes(statuses.get(id) ?? 'TIDAK_DIKENAL')),
    timeoutMs,
  )
}

export function countByStatus(statuses: ReadonlyMap<string, string>): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const status of statuses.values()) counts[status] = (counts[status] ?? 0) + 1
  return counts
}

export interface ScenarioRecord {
  readonly id: string
  readonly title: string
  /** Kegagalan yang disuntikkan, dan saat yang dipilih. */
  readonly fault: string
  readonly bookings: number
  readonly statuses: Record<string, number>
  /** Dari kegagalan DICABUT sampai seluruh pemesanan final. `null` bila tidak dicabut. */
  readonly recoveryMs: number | null
  readonly notes: readonly string[]
  readonly trace?: string | undefined
}

export async function record(result: ScenarioRecord): Promise<void> {
  await mkdir(CHAOS_DIR, { recursive: true })
  await appendFile(
    join(CHAOS_DIR, 'results.jsonl'),
    `${JSON.stringify({ ...result, recordedAt: new Date().toISOString() })}\n`,
    'utf8',
  )
}

/**
 * Mengunduh trace pemesanan dari Jaeger: trace TERAKHIR yang dicatat
 * booking-service untuk pemesanan itu — pada skenario pemulihan, trace yang
 * menuntaskannya setelah kegagalan dicabut. Berkasnya disimpan apa adanya;
 * seluruh isinya berasal dari kontainer uji sekali pakai.
 */
export async function captureTrace(
  system: System,
  bookingId: string,
  label: string,
): Promise<string> {
  const line = [...system.booking.logs]
    .reverse()
    .find((entry) => entry.raw.bookingId === bookingId && typeof entry.raw.traceId === 'string')
  const traceId = line === undefined ? undefined : String(line.raw.traceId)
  if (traceId === undefined)
    throw new Error(`log booking-service tidak menyebut trace ${bookingId}`)

  const url = `${inject('jaeger').queryUrl}/api/traces/${traceId}`
  let body = ''
  // Span diekspor berkelompok (BatchSpanProcessor, lima detik).
  await eventually(
    `trace ${traceId} tersedia di Jaeger`,
    async () => {
      const response = await request(url)
      body = await response.body.text()
      return response.statusCode === 200 && body.includes('"spans"')
    },
    30_000,
  )
  await mkdir(CHAOS_DIR, { recursive: true })
  const file = `trace-${label}-${traceId}.json`
  await writeFile(join(CHAOS_DIR, file), body, 'utf8')
  return file
}
