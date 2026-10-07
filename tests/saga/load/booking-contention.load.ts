import { afterAll, beforeAll, expect, test } from 'vitest'
import type { System } from '../harness/system.js'
import { runK6 } from './k6.js'
import { buildReport, saveReport, waitSettled } from './measure.js'
import { k6Env, prepareArena, startLoadSystem } from './setup.js'
import { assertReport, verifyRun } from './verify.js'

/**
 * US-04 / M5 — seribu pengguna, sepuluh kamar. Lihat infra/k6/booking-contention.js.
 *
 * Ketersediaan sepuluh ditetapkan di DUA tempat yang harus sepakat: stok
 * mock-supplier (panel kendali) dan kapasitas yang dilaporkan pencarian
 * (`UNITS`, yang dikirim pengguna saat hold). Bila keduanya berbeda, yang
 * lebih kecil yang menang — dan itu skenario lain.
 */

const VUS = Number(process.env.LOAD_VUS ?? 1000)
const UNITS = 10

let system: System | undefined

/** Sistem yang sudah menyala; `beforeAll` yang gagal menghentikan uji sebelum sampai sini. */
function startedSystem(): System {
  if (system === undefined) throw new Error('sistem uji beban belum menyala')
  return system
}

beforeAll(async () => {
  system = await startLoadSystem()
})

afterAll(async () => {
  // Sistem yang gagal menyala tidak punya apa pun untuk ditutup. Tanpa
  // penjagaan ini galat penutupan menimpa galat aslinya di laporan.
  if (system === undefined) return
  // Log keempat service selalu disimpan, juga saat uji gagal di tengah:
  // angka tanpa log tidak menjelaskan apa pun.
  await system.dumpLogs('beban-booking-contention')
  await system.stop()
})

test(`${String(VUS)} pengguna serentak untuk ${String(UNITS)} kamar: tepat ${String(UNITS)} CONFIRMED`, async () => {
  const system = startedSystem()
  const arena = await prepareArena(system, UNITS)

  const run = await runK6('booking-contention.js', 'booking-contention', {
    ...k6Env(system, arena),
    VUS: String(VUS),
    UNITS: String(UNITS),
    PRICE_CHECK_WINDOW_MS: process.env.LOAD_PRICE_CHECK_WINDOW_MS ?? '120000',
  })
  if (run.exitCode !== 0) process.stderr.write(run.output.slice(-4_000))

  await waitSettled(system, 600_000)
  const checks = await verifyRun(system, {
    expectedConfirmed: UNITS,
    holdTtlMs: system.infra.mockSupplier.holdTtlMs,
  })
  await saveReport(
    await buildReport(system, {
      scenario: 'booking-contention',
      config: { vus: VUS, units: UNITS },
      summary: run.summary,
      checks,
    }),
  )

  assertReport(checks)
  expect(run.exitCode).toBe(0)
})
