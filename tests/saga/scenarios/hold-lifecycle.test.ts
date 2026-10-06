import { Redis } from 'ioredis'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { bookingRow } from '../harness/db.js'
import { assertInvariants } from '../harness/invariants.js'
import { held, pay, waitForStatus } from '../harness/journey.js'
import { startSystem, type System } from '../harness/system.js'
import { waitFor } from '../harness/waits.js'

/**
 * Skenario 6 dan 7 — hold yang tidak pernah menjadi pemesanan.
 *
 * Hold LOKAL dilepas aktif (kompensasi `releaseLocalHold`). Hold SUPPLIER
 * tidak dapat dilepas aktif — tidak ada operasinya di supplier mana pun —
 * dan kompensasinya `lapses`, diputuskan pemilik proyek di Step 19 dan
 * dipertahankan di Step 20. Yang dibuktikan di sini: hold supplier BENAR-BENAR
 * hilang sendiri pada waktunya, di mock-supplier yang sesungguhnya.
 */

let system: System
let redis: Redis

beforeAll(async () => {
  system = await startSystem()
  redis = new Redis(system.infra.redisUrl)
})

afterAll(async () => {
  redis.disconnect()
  await system.stop()
})

afterEach(async (context) => {
  if (context.task.result?.state === 'fail') await system.dumpLogs(context.task.name)
  await system.reset()
})

async function holdsSeat(bookingId: string): Promise<boolean> {
  const keys = await redis.keys('booking:hold:members:*')
  for (const key of keys) {
    if ((await redis.sismember(key, bookingId)) === 1) return true
  }
  return false
}

async function supplierHoldExists(holdRef: string): Promise<boolean> {
  const { holds } = await system.supplier.reservations()
  return holds.some((hold) => hold.ref === holdRef)
}

describe('pembayaran gagal setelah hold', () => {
  test('hold lokal dilepas seketika, hold supplier habis sendiri, pemesanan final', async () => {
    const journey = await held(system)
    const row = await bookingRow(system.db.booking, journey.bookingId)
    const holdRef = row?.holdRef ?? ''
    const heldUntil = row?.heldUntil?.getTime() ?? 0
    expect(await holdsSeat(journey.bookingId)).toBe(true)
    expect(await supplierHoldExists(holdRef)).toBe(true)

    await pay(system, journey, 'deny')
    const final = await waitForStatus(system, journey, 'CANCELLED')

    // Dilepas AKTIF, bukan menunggu kunci waktunya habis: kursinya kembali
    // jauh sebelum held_until.
    await waitFor(
      'kursi lokal dilepas',
      async () => await holdsSeat(journey.bookingId),
      (holding) => !holding,
    )
    expect(Date.now()).toBeLessThan(heldUntil)
    expect(final.refund).toBeNull()
    // Hold supplier habis SENDIRI (lapses) — ditunggu, tidak dilepas.
    await waitFor(
      'hold supplier habis sendiri',
      async () => await supplierHoldExists(holdRef),
      (exists) => !exists,
      system.infra.mockSupplier.holdTtlMs + 10_000,
    )

    await assertInvariants(system, [journey.bookingId])
  })
})

describe('hold kedaluwarsa tanpa pembayaran', () => {
  test('mencapai EXPIRED, dan hold supplier ikut habis', async () => {
    const journey = await held(system)
    const holdRef = (await bookingRow(system.db.booking, journey.bookingId))?.holdRef ?? ''

    // held_until pemesanan tidak pernah lebih akhir dari kedaluwarsa hold
    // supplier (effectiveHoldUntil, Step 17), jadi keduanya habis bersamaan.
    await waitForStatus(system, journey, 'EXPIRED', system.infra.mockSupplier.holdTtlMs + 15_000)

    expect(await holdsSeat(journey.bookingId)).toBe(false)
    await waitFor(
      'hold supplier habis sendiri',
      async () => await supplierHoldExists(holdRef),
      (exists) => !exists,
      10_000,
    )

    await assertInvariants(system, [journey.bookingId])
  })
})
