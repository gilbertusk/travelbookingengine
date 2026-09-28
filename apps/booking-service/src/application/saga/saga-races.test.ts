import { describe, expect, test } from 'vitest'
import { renewLease } from '../../domain/saga-state.js'
import {
  ERROR_LEVEL,
  memoryHoldStore,
  priceCheckRequest,
  SAGA_POLICY,
  USER,
  type MemoryHoldStore,
} from '../../testing/fakes.js'
import { sagaWorld, type SagaWorld } from '../../testing/saga-world.js'
import { slotOf } from '../hold-slot.js'
import { placeHold } from '../place-hold.js'
import { startPriceCheck } from '../price-check.js'
import { recoverSaga, sweepSagas } from './sweep-sagas.js'

/**
 * Balapan antara proses yang lambat dan pemulih yang mengira proses itu mati.
 *
 * Sewa membuat pemulih menunggu; kunci versi membuat yang kalah berhenti.
 * Setiap uji di sini menjalankan "proses lain" DI TENGAH langkah proses
 * pertama — di titik yang memang dapat terjadi di produksi — dan memeriksa
 * bahwa tidak ada efek yang terjadi dua kali dan tidak ada yang tertinggal.
 */

/** Hold store yang, di tengah satu operasi, menjalankan pekerjaan "proses lain". */
function interleaved(
  inner: MemoryHoldStore,
  on: 'acquire' | 'release',
  other: () => Promise<void>,
): MemoryHoldStore {
  let pending = true
  const run = async (): Promise<void> => {
    if (!pending) return
    pending = false
    await other()
  }

  return {
    ...inner,
    acquire: async (claim) => {
      const outcome = await inner.acquire(claim)
      if (on === 'acquire') await run()
      return outcome
    },
    release: async (entry) => {
      if (on === 'release') await run()
      return await inner.release(entry)
    },
  }
}

describe('proses lambat dan pemulih', () => {
  test('hold yang melampaui sewanya: pemulih mengambil alih, proses lambat berhenti tanpa ke supplier', async () => {
    const holds = interleaved(memoryHoldStore(), 'acquire', async () => {
      // Proses lambat tertahan setelah Redis menjawab; sewanya habis, dan
      // instance lain memulihkan saganya.
      world.advance(SAGA_POLICY.leaseMs)
      await sweepSagas(world.restart().deps)
    })
    const world: SagaWorld = sagaWorld({ holds })
    const checked = await startPriceCheck(world.deps, priceCheckRequest())
    if (checked.kind !== 'checked') throw new Error('persiapan gagal')

    const result = await placeHold(world.deps, {
      userId: USER,
      bookingId: checked.booking.id,
      unitsLeft: 5,
    })

    expect(result.kind).toBe('in_progress')
    expect(world.suppliers.holds).toHaveLength(0)
    expect(world.holds.held(slotOf(checked.booking))).toBe(0)
    expect(await world.saga(checked.booking.id)).toMatchObject({ phase: 'compensated' })
  })

  test('pelepasan hold yang disusul pemulih: kursi kembali sekali, saga tidak ditimpa', async () => {
    const holds = interleaved(memoryHoldStore(), 'release', async () => {
      const paid = [...world.db.committed().bookings.keys()][0] ?? ''
      const saga = await world.saga(paid)
      if (saga === undefined) return
      await world.deps.sagas.commit({
        bookingId: paid,
        at: world.now(),
        saga: renewLease(saga, world.now(), SAGA_POLICY.leaseMs),
      })
    })
    const world: SagaWorld = sagaWorld({ holds })
    const paid = await world.paid()

    await world.supplierRejected(paid)

    // Proses pertama kalah menyimpan kemajuannya; penunjuk masih milik pemulih.
    expect(await world.saga(paid.id)).toMatchObject({
      phase: 'compensating',
      compensating: 'holdLocal',
    })
    world.advance(SAGA_POLICY.leaseMs)
    await sweepSagas(world.deps)
    expect(world.holds.held(slotOf(paid))).toBe(0)
    expect(await world.saga(paid.id)).toMatchObject({ compensating: undefined })
  })

  test('dua pemulih untuk saga yang sama: hanya satu yang melanjutkan', async () => {
    let failures = 1
    let released = 0
    const inner = memoryHoldStore()
    const holds: MemoryHoldStore = {
      ...inner,
      release: async (entry) => {
        if (failures > 0) {
          failures -= 1
          throw new Error('redis sesaat mati')
        }
        const removed = await inner.release(entry)
        if (removed) released += 1
        return removed
      },
    }
    const world = sagaWorld({ holds })
    const paid = await world.paid()
    await world.supplierRejected(paid)
    world.advance(SAGA_POLICY.compensationRetry.retryDelayMs)
    const saga = await world.saga(paid.id)
    if (saga === undefined) throw new Error('persiapan gagal')

    await Promise.all([recoverSaga(world.deps, saga), recoverSaga(world.restart().deps, saga)])

    expect(released).toBe(1)
    expect(world.holds.held(slotOf(paid))).toBe(0)
    expect(await world.saga(paid.id)).toMatchObject({ compensating: undefined })
  })
})

describe('pembayaran yang nilainya tidak sama dengan harga yang disetujui', () => {
  test('ditolak domain dan dikembalikan, pemesanan tetap HELD, dengan galat tingkat error', async () => {
    const world = sagaWorld()
    const held = await world.held()

    await world.paymentSucceeded(held, {
      amount: { ...held.price.total, amountMinor: held.price.total.amountMinor + 1 },
    })

    expect(await world.booking(held.id)).toMatchObject({ status: 'HELD' })
    expect(world.sent(held.id)).toContain('payment.refund')
    expect(world.sent(held.id)).not.toContain('supplier.confirm')
    expect(world.logs().some((entry) => entry.level === ERROR_LEVEL)).toBe(true)
  })
})
