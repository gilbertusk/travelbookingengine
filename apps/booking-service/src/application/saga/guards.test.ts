import { describe, expect, test } from 'vitest'
import { awaitReply, beginSaga, completeSaga, enterStep } from '../../domain/saga-state.js'
import { inState } from '../../testing/builders.js'
import { ERROR_LEVEL, SAGA_POLICY } from '../../testing/fakes.js'
import { sagaWorld } from '../../testing/saga-world.js'
import { expireHold } from '../expire-hold.js'
import { persist } from '../persist.js'
import { mustApply, react, requireSaga, sagaIfChanged } from './reaction.js'
import { handleDeadline, recoverSaga, sweepSagas } from './sweep-sagas.js'

/**
 * Penjaga: cabang yang hanya tersentuh bila ada cacat — di pemanggil, di
 * baris basis data, atau di tabel. Setiap penjaga di jalur saga diuji dengan
 * pelanggaran yang disengaja; penjaga yang tidak pernah terbukti menolak
 * sama dengan penjaga yang tidak ada.
 */

const T0 = new Date('2026-10-01T03:00:00.000Z')

describe('kerangka reaksi', () => {
  test('perintah yang ditolak domain adalah cacat pemanggil, dilempar', () => {
    expect(() => mustApply(inState('CONFIRMED'), { type: 'fail', at: T0, reason: 'x' })).toThrow(
      /ditolak/,
    )
  })

  test('pemesanan berbayar tanpa saga adalah cacat, dilempar', () => {
    expect(() => requireSaga(undefined, inState('PAID'))).toThrow(/tidak punya saga/)
  })

  test('saga yang tidak berubah tidak ikut disimpan', () => {
    const saga = beginSaga('b', T0, 1)
    const next = enterStep(saga, 'holdSupplier', T0, 1)

    expect(sagaIfChanged(saga, saga)).toEqual({})
    expect(sagaIfChanged(saga, next)).toEqual({ saga: next })
  })

  test('kalah balapan terus-menerus: pesan dilempar kembali ke Kafka, bukan diputar selamanya', async () => {
    const world = sagaWorld()
    const held = await world.held()
    let decisions = 0

    await expect(
      react(world.deps, { eventId: 'e', eventType: 'x', bookingId: held.id }, async () => {
        decisions += 1
        return await Promise.resolve('stale' as const)
      }),
    ).rejects.toThrow(/kalah balapan 3 kali/)
    expect(decisions).toBe(3)
  })
})

describe('hold tanpa saga', () => {
  test('pemesanan HELD tanpa saga tidak dikedaluwarsakan diam-diam', async () => {
    const world = sagaWorld()
    const held = await world.held()
    // Baris saga dihapus, meniru pemesanan HELD yang ditulis di luar jalur hold.
    world.db.committed().sagas.delete(held.id)
    world.advance(SAGA_POLICY.leaseMs * 100)

    await expect(expireHold(world.deps, held.id)).rejects.toThrow(/tidak punya saga/)
  })
})

describe('penyapu saga', () => {
  test('saga tanpa pemesanan adalah baris rusak', async () => {
    const world = sagaWorld()
    const orphan = beginSaga('00000000-0000-4000-8000-00000000dead', T0, 1)

    await expect(handleDeadline(world.deps, orphan)).rejects.toThrow(/tanpa pemesanan/)
    await expect(recoverSaga(world.deps, orphan)).rejects.toThrow(/tanpa pemesanan/)
  })

  test('batas waktu tanpa penantian yang dikenal adalah baris rusak', async () => {
    const world = sagaWorld()
    const held = await world.held()
    const saga = completeSaga(beginSaga(held.id, T0, 1), T0)

    await expect(handleDeadline(world.deps, saga)).rejects.toThrow(/tanpa penantian/)
  })

  test('langkah yang boleh diulang tidak pernah "dimulai" langsung; menemukannya adalah cacat', async () => {
    const world = sagaWorld()
    const held = await world.held()
    const saga = enterStep(beginSaga(held.id, T0, 1), 'confirmSupplier', T0, 1)

    await expect(recoverSaga(world.deps, saga)).rejects.toThrow(/boleh diulang/)
  })

  test('saga tanpa kompensasi langsung yang tertunda tidak disentuh pemulihan', async () => {
    const world = sagaWorld()
    const held = await world.held()
    const waiting = awaitReply(beginSaga(held.id, T0, 1), 'awaitPayment', T0, undefined)

    await expect(recoverSaga(world.deps, completeSaga(waiting, T0))).resolves.toBeUndefined()
  })

  test('satu saga yang gagal ditangani tidak menghentikan putaran; galatnya tingkat error', async () => {
    const world = sagaWorld()
    const paid = await world.paid()
    // Pemesanan dipindahkan tanpa sagannya — baris saga kini tidak sepakat.
    const booking = await world.booking(paid.id)
    await persist(world.deps, booking, { type: 'fail', at: world.now(), reason: 'di luar saga' })
    await persist(world.deps, await world.booking(paid.id), {
      type: 'recordRefund',
      at: world.now(),
      refundId: 'e1f2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a5b',
      amount: paid.price.total,
    })
    world.advance(SAGA_POLICY.confirmTimeoutMs)

    const report = await sweepSagas(world.deps)

    expect(report.failed).toBe(1)
    expect(world.logs().some((entry) => entry.level === ERROR_LEVEL)).toBe(true)
  })

  test('pemulihan yang gagal dihitung gagal, bukan pulih, dan tidak menghentikan putaran', async () => {
    const world = sagaWorld()
    const held = await world.held()
    const broken = enterStep(beginSaga(held.id, T0, 1), 'confirmSupplier', T0, 1)
    const deps = {
      ...world.deps,
      sagas: { ...world.deps.sagas, findLeaseExpired: async () => await Promise.resolve([broken]) },
    }

    expect(await sweepSagas(deps)).toEqual({ timedOut: 0, recovered: 0, failed: 1 })
  })
})
