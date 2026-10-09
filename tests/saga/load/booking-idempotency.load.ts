import { afterAll, beforeAll, expect, test } from 'vitest'
import type { System } from '../harness/system.js'
import { runK6 } from './k6.js'
import { buildReport, saveReport, waitSettled } from './measure.js'
import { k6Env, prepareArena, startLoadSystem } from './setup.js'
import { assertReport, verifyRun, type Check } from './verify.js'

/**
 * FR-18 / US-05 — permintaan identik serentak. Lihat infra/k6/booking-idempotency.js.
 *
 * Stoknya melimpah: yang diuji di sini penggandaan, bukan rebutan. Setiap
 * kunci harus berakhir dengan TEPAT satu pemesanan, satu pembayaran, dan satu
 * pemesanan di supplier — dan seluruhnya CONFIRMED.
 */

const KEYS = Number(process.env.LOAD_KEYS ?? 50)
const COPIES = Number(process.env.LOAD_COPIES ?? 10)

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
  await system.dumpLogs('beban-booking-idempotency')
  await system.stop()
})

test(`${String(KEYS)} kunci × ${String(COPIES)} salinan serentak: satu pemesanan per kunci`, async () => {
  const system = startedSystem()
  const arena = await prepareArena(system, 10_000)

  const run = await runK6('booking-idempotency.js', 'booking-idempotency', {
    ...k6Env(system, arena),
    KEYS: String(KEYS),
    COPIES: String(COPIES),
    RUN_ID: String(Date.now()),
  })
  if (run.exitCode !== 0) process.stderr.write(run.output.slice(-4_000))

  await waitSettled(system, 600_000)
  const checks = [
    ...(await verifyRun(system, {
      expectedConfirmed: KEYS,
      holdTtlMs: system.infra.mockSupplier.holdTtlMs,
    })),
    await onePerKey(system),
  ]
  await saveReport(
    await buildReport(system, {
      scenario: 'booking-idempotency',
      config: { keys: KEYS, copies: COPIES },
      summary: run.summary,
      checks,
    }),
  )

  assertReport(checks)
  expect(run.exitCode).toBe(0)
})

/** Satu pemesanan per pengguna (= per kunci), dan satu pembayaran per pemesanan. */
async function onePerKey(system: System): Promise<Check> {
  const bookings = await system.db.booking.query<{ user_id: string; count: string }>(
    'SELECT user_id, count(*) AS count FROM bookings GROUP BY user_id HAVING count(*) > 1',
  )
  const payments = await system.db.payment.query<{ booking_id: string; count: string }>(
    'SELECT booking_id, count(*) AS count FROM payments GROUP BY booking_id HAVING count(*) > 1',
  )
  const users = await system.db.booking.query<{ count: string }>(
    'SELECT count(DISTINCT user_id) AS count FROM bookings',
  )

  return {
    name: 'Satu pemesanan per kunci, satu pembayaran per pemesanan',
    ok: bookings.rows.length === 0 && payments.rows.length === 0,
    detail:
      `${String(users.rows[0]?.count ?? 0)} kunci, ` +
      `${String(bookings.rows.length)} kunci dengan pemesanan ganda, ` +
      `${String(payments.rows.length)} pemesanan dengan pembayaran ganda`,
  }
}
