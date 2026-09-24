import { describe, expect, test } from 'vitest'
import type { CircuitPolicy } from '../domain/circuit.js'
import { callSupplier } from './call-supplier.js'
import { search } from './supplier-operations.js'
import {
  booking,
  denyingRateLimiter,
  err,
  failure,
  harness,
  memoryCircuitStore,
  memoryDirectory,
  ok,
} from '../testing/fakes.js'

/**
 * Lapisan ketahanan di sekeliling satu panggilan.
 *
 * Yang diuji bukan bahwa adapter bekerja — itu sudah dibuktikan Step 10 —
 * melainkan bahwa pemutus, pembatas laju, percobaan ulang, dan pencatatan
 * berlaku dalam urutan yang benar, dan bahwa masing-masing berhenti pada
 * saat yang tepat.
 */

const POLICY: CircuitPolicy = {
  failureThreshold: 3,
  windowMs: 10_000,
  openDurationMs: 5_000,
  successesToClose: 2,
}

const CRITERIA = { city: 'Bali', checkIn: '2026-11-10', checkOut: '2026-11-12', guests: 2 }

function callOnce(world: ReturnType<typeof harness>) {
  return callSupplier(world.deps, {
    supplier: 'SKY',
    operation: 'book',
    noRetry: true,
    run: async () => await world.gateway.book('h', { fullName: 'B' }, 'k'),
  })
}

describe('pemutus sirkuit', () => {
  test('terbuka setelah ambang kegagalan, lalu berhenti memanggil supplier', () => {
    // Inilah yang membuat kegagalan satu supplier tidak menurunkan latensi
    // alur pencarian: setelah terbuka, penolakan terjadi tanpa menyentuh
    // jaringan sama sekali.
    const world = harness({
      script: { book: [err(failure('SKY', 'book', 'timeout'))] },
      circuitPolicy: POLICY,
    })

    return (async () => {
      for (let index = 0; index < POLICY.failureThreshold; index += 1) await callOnce(world)

      const callsBefore = world.gateway.calls.length
      const blocked = await callOnce(world)

      expect(world.gateway.calls.length).toBe(callsBefore)
      expect(blocked.ok).toBe(false)
      if (blocked.ok) return
      expect(blocked.error.kind).toBe('unavailable')
    })()
  })

  test('menerbitkan supplier.degraded sekali saat terbuka', async () => {
    const world = harness({
      script: { book: [err(failure('SKY', 'book', 'timeout'))] },
      circuitPolicy: POLICY,
    })

    for (let index = 0; index < POLICY.failureThreshold + 2; index += 1) await callOnce(world)

    const degraded = world.events.published.filter((event) => event.type === 'degraded')
    expect(degraded).toHaveLength(1)
    expect(degraded[0]?.supplier).toBe('SKY')
  })

  test('pulih bertahap dan menerbitkan supplier.recovered', async () => {
    const world = harness({
      script: {
        book: [
          err(failure('SKY', 'book', 'timeout')),
          err(failure('SKY', 'book', 'timeout')),
          err(failure('SKY', 'book', 'timeout')),
          ok(booking('SKY', 'bkg_1')),
          ok(booking('SKY', 'bkg_2')),
        ],
      },
      circuitPolicy: POLICY,
    })

    for (let index = 0; index < 3; index += 1) await callOnce(world)
    expect(world.events.published.some((event) => event.type === 'degraded')).toBe(true)

    // Menunggu durasi terbuka lewat — tanpa benar-benar menunggu.
    world.clock.advance(POLICY.openDurationMs)

    await callOnce(world)
    expect(world.events.published.some((event) => event.type === 'recovered')).toBe(false)

    await callOnce(world)
    expect(world.events.published.filter((event) => event.type === 'recovered')).toHaveLength(1)
  })

  test('kamar habis TIDAK membuka pemutus', async () => {
    // Jawaban yang benar dari supplier yang sehat. Menghitungnya akan membuka
    // pemutus tepat saat permintaan sedang tinggi.
    const world = harness({
      script: { book: [err(failure('SKY', 'book', 'sold_out'))] },
      circuitPolicy: POLICY,
    })

    for (let index = 0; index < POLICY.failureThreshold + 2; index += 1) await callOnce(world)

    const last = await callOnce(world)
    expect(last.ok).toBe(false)
    if (last.ok) return
    // Masih sold_out, bukan unavailable — artinya pemutus tetap tertutup.
    expect(last.error.kind).toBe('sold_out')
    expect(world.events.published).toHaveLength(0)
  })

  test('kuota habis juga tidak membuka pemutus', async () => {
    // Supplier sedang melindungi dirinya; yang harus menyesuaikan adalah
    // pembatas laju keluar kita, bukan pemutus.
    const world = harness({
      script: { book: [err(failure('SKY', 'book', 'rate_limited'))] },
      circuitPolicy: POLICY,
    })

    for (let index = 0; index < POLICY.failureThreshold + 2; index += 1) await callOnce(world)

    expect(world.events.published).toHaveLength(0)
  })
})

describe('keadaan pemutus dibagikan antar instance', () => {
  test('dua instance yang berbagi penyimpanan mencapai ambang bersama-sama', async () => {
    // Pemutus yang hitungannya per-proses berarti sepuluh replika
    // masing-masing menembak supplier yang sudah jelas tumbang sebanyak lima
    // kali sebelum berhenti — lima puluh panggilan sia-sia.
    const shared = memoryCircuitStore()
    const directory = memoryDirectory({ SKY: { circuit: POLICY } })

    const first = harness({
      script: { book: [err(failure('SKY', 'book', 'timeout'))] },
      circuits: shared,
      directory,
    })
    const second = harness({
      script: { book: [err(failure('SKY', 'book', 'timeout'))] },
      circuits: shared,
      directory,
    })

    // Dua kegagalan di instance pertama, satu di instance kedua.
    await callOnce(first)
    await callOnce(first)
    await callOnce(second)

    // Instance kedua ikut menolak, meski ia sendiri baru gagal satu kali.
    const callsBefore = second.gateway.calls.length
    const blocked = await callOnce(second)

    expect(second.gateway.calls.length).toBe(callsBefore)
    expect(blocked.ok).toBe(false)
    if (blocked.ok) return
    expect(blocked.error.kind).toBe('unavailable')
  })

  test('instance yang belum pernah gagal pun ikut menolak', async () => {
    const shared = memoryCircuitStore()
    const directory = memoryDirectory({ SKY: { circuit: POLICY } })

    const busy = harness({
      script: { book: [err(failure('SKY', 'book', 'timeout'))] },
      circuits: shared,
      directory,
    })
    const fresh = harness({
      script: { book: [ok(booking('SKY', 'bkg_1'))] },
      circuits: shared,
      directory,
    })

    for (let index = 0; index < POLICY.failureThreshold; index += 1) await callOnce(busy)

    const blocked = await callOnce(fresh)

    expect(fresh.gateway.calls).toHaveLength(0)
    expect(blocked.ok).toBe(false)
  })
})

describe('pembatas laju keluar', () => {
  test('menolak tanpa memanggil supplier ketika kuota habis', async () => {
    const world = harness({
      script: { book: [ok(booking('SKY', 'bkg_1'))] },
      rateLimiter: denyingRateLimiter(2_000),
    })

    const result = await callOnce(world)

    expect(world.gateway.calls).toHaveLength(0)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('rate_limited')
    if (result.error.kind !== 'rate_limited') return
    expect(result.error.retryAfterSeconds).toBe(2)
  })
})

describe('percobaan ulang', () => {
  test('batas waktu dicoba ulang sampai berhasil', async () => {
    const world = harness({
      script: {
        search: [err(failure('SKY', 'search', 'timeout')), ok(searchResult())],
      },
    })

    const result = await search(world.deps, 'SKY', CRITERIA)

    expect(result.ok).toBe(true)
    expect(world.gateway.calls).toEqual(['search', 'search'])
    expect(world.sleeper.slept).toHaveLength(1)
  })

  test('respons cacat TIDAK dicoba ulang', async () => {
    const world = harness({
      script: { search: [err(failure('SKY', 'search', 'invalid_response'))] },
    })

    const result = await search(world.deps, 'SKY', CRITERIA)

    expect(result.ok).toBe(false)
    expect(world.gateway.calls).toEqual(['search'])
    expect(world.sleeper.slept).toHaveLength(0)
  })

  test('kamar habis tidak dicoba ulang', async () => {
    const world = harness({
      script: { search: [err(failure('SKY', 'search', 'sold_out'))] },
    })

    await search(world.deps, 'SKY', CRITERIA)

    expect(world.gateway.calls).toEqual(['search'])
  })

  test('percobaan ulang tercatat sebagai metrik', async () => {
    const world = harness({
      script: { search: [err(failure('SKY', 'search', 'timeout')), ok(searchResult())] },
    })

    await search(world.deps, 'SKY', CRITERIA)

    expect(world.metrics.retries).toEqual(['SKY:search:timeout'])
  })

  test('berhenti setelah batas percobaan, bukan berputar selamanya', async () => {
    const world = harness({ script: { search: [err(failure('SKY', 'search', 'timeout'))] } })

    const result = await search(world.deps, 'SKY', CRITERIA)

    expect(result.ok).toBe(false)
    expect(world.gateway.calls.length).toBeLessThanOrEqual(3)
  })
})

describe('pencatatan permintaan', () => {
  test('setiap percobaan dicatat dengan nomornya sendiri', async () => {
    const world = harness({
      script: { search: [err(failure('SKY', 'search', 'timeout')), ok(searchResult())] },
    })

    await search(world.deps, 'SKY', CRITERIA)

    expect(world.log.entries.map((entry) => entry.attemptNumber)).toEqual([1, 2])
    expect(world.log.entries.map((entry) => entry.outcome)).toEqual(['failure', 'success'])
  })

  test('kredensial di payload tidak pernah ikut tercatat', async () => {
    const world = harness({ script: { search: [ok(searchResult())] } })

    await callSupplier(world.deps, {
      supplier: 'SKY',
      operation: 'search',
      requestPayload: { city: 'Bali', apiKey: 'rahasia-sekali' },
      run: async () => await world.gateway.search(CRITERIA),
    })

    expect(JSON.stringify(world.log.entries[0]?.requestPayload)).not.toContain('rahasia-sekali')
  })
})

describe('supplier yang dinonaktifkan operator', () => {
  test('tidak dihubungi sama sekali', async () => {
    const world = harness({
      script: { search: [ok(searchResult())] },
      directory: memoryDirectory({ SKY: { isActive: false } }),
    })

    const result = await search(world.deps, 'SKY', CRITERIA)

    expect(world.gateway.calls).toHaveLength(0)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('unavailable')
  })
})

function searchResult() {
  return {
    supplier: 'SKY' as const,
    checkIn: '2026-11-10',
    checkOut: '2026-11-12',
    properties: [],
  }
}
