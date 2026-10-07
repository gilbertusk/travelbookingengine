import { afterAll, beforeAll, expect, test } from 'vitest'
import type { System } from '../harness/system.js'
import { runK6 } from './k6.js'
import { buildReport, saveReport, waitSettled } from './measure.js'
import { k6Env, prepareArena, startLoadSystem } from './setup.js'
import { assertReport, verifyRun } from './verify.js'

/**
 * Kerangka bersama dua skenario "supplier gagal di tengah beban".
 *
 * Bebannya sama persis — infra/k6/booking-supplier-failure.js — dan yang
 * berbeda hanya CARA supplier gagal. Perbedaan itu menentukan akhir setiap
 * pemesanan yang sudah dibayar, dan justru itulah yang diukur:
 *
 * - koneksi diterima lalu diputus → TIDAK PASTI → ditinjau manusia (US-05);
 * - jawaban 503 → PASTI tidak dikerjakan → refund otomatis (US-03).
 *
 * Satu skenario per jalan: pemeriksaan sesudahnya membaca seluruh tabel.
 */

const RATE = Number(process.env.LOAD_RATE ?? 2)
const DURATION_S = Number(process.env.LOAD_DURATION_S ?? 60)

export interface Outage {
  /** Nama laporan dan berkas log. */
  readonly scenario: string
  readonly title: string
  /** Membuat supplier gagal. Dipanggil di tengah beban. */
  fail(system: System): Promise<void>
  /** Mengembalikan supplier, setelah seluruh pemesanan tuntas. */
  restore(system: System): Promise<void>
}

export function defineOutageScenario(outage: Outage): void {
  let system: System | undefined

  beforeAll(async () => {
    system = await startLoadSystem()
  })

  afterAll(async () => {
    // Sistem yang gagal menyala tidak punya apa pun untuk ditutup. Tanpa
    // penjagaan ini galat penutupan menimpa galat aslinya di laporan.
    if (system === undefined) return
    // Log keempat service selalu disimpan, juga saat uji gagal di tengah:
    // angka tanpa log tidak menjelaskan apa pun.
    await system.dumpLogs(`beban-${outage.scenario}`)
    await outage.restore(system)
    await system.stop()
  })

  test(outage.title, async () => {
    if (system === undefined) throw new Error('sistem uji beban belum menyala')
    const arena = await prepareArena(system, 10_000)

    const running = runK6('booking-supplier-failure.js', outage.scenario, {
      ...k6Env(system, arena),
      RATE: String(RATE),
      DURATION: `${String(DURATION_S)}s`,
    })
    // Gagal di tengah: setengah durasi. Bukan jeda tebakan atas sistem — ini
    // jadwal skenarionya sendiri, sama dengan durasi beban yang diatur k6.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, (DURATION_S * 1_000) / 2)
    })
    const failedAt = new Date()
    await outage.fail(system)

    const run = await running
    if (run.exitCode !== 0) process.stderr.write(run.output.slice(-4_000))

    // Supplier dikembalikan hanya setelah seluruh pemesanan tuntas.
    // Mengembalikannya lebih awal membuat perintah yang masih di jenjang
    // retry diam-diam berhasil, dan skenario gagal berubah menjadi alur bahagia.
    await waitSettled(system, 900_000)
    await outage.restore(system)

    const checks = await verifyRun(system, { holdTtlMs: system.infra.mockSupplier.holdTtlMs })
    await saveReport(
      await buildReport(system, {
        scenario: outage.scenario,
        config: { rate: RATE, durationS: DURATION_S, failedAt: failedAt.toISOString() },
        summary: run.summary,
        checks,
      }),
    )

    assertReport(checks)
    expect(run.exitCode).toBe(0)
  })
}
