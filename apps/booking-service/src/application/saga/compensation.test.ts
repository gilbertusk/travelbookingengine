import { describe, expect, test } from 'vitest'
import {
  COMPENSATION_ACTIONS,
  DIRECT_COMPENSATIONS,
  OUTBOX_COMPENSATIONS,
  SAGA_DEFINITION,
  directActionOf,
} from '../../domain/saga-definition.js'
import { inState } from '../../testing/builders.js'
import { ERROR_LEVEL, SAGA_POLICY, type MemoryHoldStore } from '../../testing/fakes.js'
import { sagaWorld } from '../../testing/saga-world.js'
import { slotOf } from '../hold-slot.js'
import { compensationCommandFor, DIRECT_ACTIONS, OUTBOX_ACTIONS } from './compensation.js'
import { sweepSagas } from './sweep-sagas.js'

/**
 * Pelaksana kompensasi. Cakupan jalur kompensasi wajib 100% (CONVENTIONS.md
 * bagian 10); setiap cabang di compensation.ts punya uji di sini atau di
 * saga-flow.test.ts dan recovery.test.ts.
 */

/** Redis yang menolak pelepasan sebanyak `times` kali. */
function failingRelease(inner: MemoryHoldStore, times: number, error: unknown): MemoryHoldStore {
  let remaining = times
  return {
    ...inner,
    release: async (entry) => {
      if (remaining > 0) {
        remaining -= 1
        await Promise.resolve()
        throw error
      }
      return await inner.release(entry)
    },
  }
}

describe('setiap aksi di tabel punya implementasi pada rutenya', () => {
  test('aksi langsung dan aksi outbox bersama-sama mencakup seluruh aksi kompensasi', () => {
    expect([...Object.keys(DIRECT_ACTIONS), ...Object.keys(OUTBOX_ACTIONS)].sort()).toEqual(
      [...COMPENSATION_ACTIONS].sort(),
    )
    expect(Object.keys(DIRECT_ACTIONS)).toEqual([...DIRECT_COMPENSATIONS])
    expect(Object.keys(OUTBOX_ACTIONS)).toEqual([...OUTBOX_COMPENSATIONS])
  })

  test.each(SAGA_DEFINITION.filter((step) => step.compensation.kind === 'run'))(
    '$name: kompensasinya dapat dijalankan pelaksana',
    (step) => {
      const compensation = step.compensation
      if (compensation.kind !== 'run') throw new Error('filter di atas')
      const registry: object = compensation.via === 'direct' ? DIRECT_ACTIONS : OUTBOX_ACTIONS
      expect(compensation.action in registry).toBe(true)
    },
  )

  test('penunjuk ke langkah tanpa kompensasi langsung adalah cacat, bukan dilewati', () => {
    expect(directActionOf('holdLocal')).toBe('releaseLocalHold')
    expect(() => directActionOf('awaitPayment')).toThrow(/tidak punya kompensasi langsung/)
  })

  test('kompensasi satu langkah dibaca dari tabel; langkah tanpa kompensasi outbox ditolak', () => {
    const booking = inState('CONFIRMED')

    expect(
      compensationCommandFor('confirmSupplier', { booking, supplierRef: 'X-1' }),
    ).toMatchObject({
      type: 'supplier.cancel',
      payload: { supplierRef: 'X-1' },
    })
    expect(() => compensationCommandFor('holdLocal', { booking })).toThrow(/outbox/)
  })

  test('refund untuk pemesanan tanpa pembayaran adalah cacat pemanggil', () => {
    expect(() => OUTBOX_ACTIONS.refundPayment({ booking: inState('HELD') })).toThrow(
      /tanpa pembayaran/,
    )
  })

  test('pembatalan di supplier tanpa booking reference adalah cacat pemanggil', () => {
    expect(() => OUTBOX_ACTIONS.cancelSupplierBooking({ booking: inState('FAILED') })).toThrow(
      /tanpa booking reference/,
    )
  })
})

describe('kompensasi langsung yang gagal TIDAK diabaikan', () => {
  test('dijadwalkan ulang, lalu diselesaikan penyapu saga setelah jedanya', async () => {
    const holds = sagaWorld().holds
    const world = sagaWorld({ holds: failingRelease(holds, 1, new Error('redis sesaat mati')) })
    const paid = await world.paid()

    await world.supplierRejected(paid)

    expect(world.holds.held(slotOf(paid))).toBe(1)
    expect(await world.saga(paid.id)).toMatchObject({
      phase: 'compensating',
      compensating: 'holdLocal',
      attempts: 1,
      lastError: 'redis sesaat mati',
    })

    world.advance(SAGA_POLICY.compensationRetry.retryDelayMs)
    await sweepSagas(world.deps)

    expect(world.holds.held(slotOf(paid))).toBe(0)
    expect(await world.saga(paid.id)).toMatchObject({
      phase: 'compensating',
      compensating: undefined,
    })
  })

  test('setelah percobaan habis: diserahkan ke manusia dengan galat tingkat error', async () => {
    const holds = sagaWorld().holds
    const tries = SAGA_POLICY.compensationRetry.maxAttempts
    // Bukan Error: Redis yang melempar nilai lain tetap tercatat, bukan hilang.
    const world = sagaWorld({ holds: failingRelease(holds, tries, 'ECONNRESET') })
    const paid = await world.paid()

    await world.supplierRejected(paid)
    for (let attempt = 1; attempt < tries; attempt += 1) {
      world.advance(SAGA_POLICY.compensationRetry.retryDelayMs)
      await sweepSagas(world.deps)
    }

    expect(await world.saga(paid.id)).toMatchObject({
      phase: 'review',
      compensation: 'failed',
      lastError: 'ECONNRESET',
    })
    const errors = world.logs().filter((entry) => entry.level === ERROR_LEVEL)
    expect(errors.map((entry) => entry.msg)).toContain(
      'kompensasi gagal setelah seluruh percobaan, saga diserahkan ke peninjauan manusia',
    )
  })
})
