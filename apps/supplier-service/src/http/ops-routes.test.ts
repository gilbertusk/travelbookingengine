import { USER_ID_HEADER, USER_ROLE_HEADER, createLogger } from '@tbe/shared-kernel'
import request from 'supertest'
import { describe, expect, test } from 'vitest'
import type { RequestRecord } from '../application/ports.js'
import { createSupplierHttpApp } from '../composition/app.js'
import { DEFAULT_CIRCUIT_POLICY } from '../domain/circuit.js'
import {
  harness,
  memoryCircuitStore,
  memoryDirectory,
  memoryHistory,
  type StoredRequest,
} from '../testing/fakes.js'

const logger = createLogger({ serviceName: 'supplier-service-test', level: 'silent' })
const OPERATOR = { [USER_ID_HEADER]: 'user-ops', [USER_ROLE_HEADER]: 'operator' }
const WINDOW_MS = 900_000

function app(world: ReturnType<typeof harness>, stored: readonly StoredRequest[] = []) {
  return createSupplierHttpApp({
    deps: world.deps,
    logger,
    serviceName: 'supplier-service',
    history: memoryHistory(stored),
    healthWindow: { windowMs: WINDOW_MS, sampleLimit: 3 },
  }).app
}

/** Palsuan direktori hanya mendaftar supplier yang pernah di-`update`, seperti tabel yang di-seed. */
async function seeded(overrides: Parameters<typeof memoryDirectory>[0] = {}) {
  const directory = memoryDirectory(overrides)
  await directory.update('SKY', {})
  return directory
}

function attempt(overrides: Partial<RequestRecord> & { readonly at: number }): RequestRecord {
  const { at, ...rest } = overrides
  return {
    id: `req-${String(at)}`,
    supplier: 'SKY',
    operation: 'search',
    outcome: 'success',
    errorKind: null,
    attemptNumber: 1,
    latencyMs: 100,
    requestPayload: null,
    responsePayload: null,
    createdAt: new Date(at),
    ...rest,
  }
}

describe('penjagaan rute operator di service', () => {
  test('tanpa identitas gateway: 401 untuk setiap rute /ops', async () => {
    const world = harness({ directory: memoryDirectory() })

    for (const call of [
      request(app(world)).get('/ops/suppliers'),
      request(app(world)).get('/ops/suppliers/requests?idempotencyKey=k'),
      request(app(world)).patch('/ops/suppliers/SKY').send({ isActive: false }),
    ]) {
      expect((await call).status).toBe(401)
    }
  })

  test('pelanggan: 403, dan konfigurasi tidak berubah', async () => {
    const directory = memoryDirectory()
    const world = harness({ directory })

    const response = await request(app(world))
      .patch('/ops/suppliers/SKY')
      .set(USER_ID_HEADER, 'user-1')
      .set(USER_ROLE_HEADER, 'customer')
      .send({ isActive: false })

    expect(response.status).toBe(403)
    expect((await directory.get('SKY'))?.isActive).toBe(true)
  })
})

describe('GET /ops/suppliers — kesehatan (FR-31)', () => {
  test('pemutus per OPERASI: book terbuka sementara search tertutup', async () => {
    const policy = { ...DEFAULT_CIRCUIT_POLICY, failureThreshold: 1 }
    const directory = await seeded({ SKY: { circuit: policy } })
    const circuits = memoryCircuitStore()
    const world = harness({ directory, circuits })
    await circuits.record(
      { supplier: 'SKY', operation: 'book' },
      'failure',
      policy,
      world.clock.now(),
    )

    const response = await request(app(world)).get('/ops/suppliers').set(OPERATOR)

    expect(response.status).toBe(200)
    const sky = response.body.data.find((row: { code: string }) => row.code === 'SKY')
    expect(sky.circuits).toEqual({
      search: 'closed',
      priceCheck: 'closed',
      hold: 'closed',
      book: 'open',
      cancel: 'closed',
    })
  })

  test('statistik jendela hanya memuat percobaan supplier itu dan di dalam jendela', async () => {
    const world = harness({ directory: await seeded() })
    const now = world.clock.now()
    const stored = [
      { idempotencyKey: null, record: attempt({ at: now - 1_000, latencyMs: 200 }) },
      {
        idempotencyKey: null,
        record: attempt({ at: now - 2_000, latencyMs: 400, outcome: 'failure' }),
      },
      // Di luar jendela: tidak dihitung.
      { idempotencyKey: null, record: attempt({ at: now - WINDOW_MS - 1, latencyMs: 9_999 }) },
      // Supplier lain: tidak dihitung untuk SKY.
      { idempotencyKey: null, record: attempt({ at: now - 500, supplier: 'NOVA' }) },
    ]

    const response = await request(app(world, stored)).get('/ops/suppliers').set(OPERATOR)

    const sky = response.body.data.find((row: { code: string }) => row.code === 'SKY')
    expect(sky.window).toMatchObject({
      attempts: 2,
      failures: 1,
      errorRateBasisPoints: 5_000,
      latencyP95Ms: 400,
      windowMs: WINDOW_MS,
    })
  })

  test('batas sampel tercapai ditandai, supaya angka tidak dibaca sebagai lengkap', async () => {
    const world = harness({ directory: await seeded() })
    const now = world.clock.now()
    const stored = [1, 2, 3, 4].map((offset) => ({
      idempotencyKey: null,
      record: attempt({ at: now - offset }),
    }))

    const response = await request(app(world, stored)).get('/ops/suppliers').set(OPERATOR)

    expect(response.body.data[0].window.isTruncated).toBe(true)
  })
})

describe('GET /ops/suppliers/requests — riwayat satu pemesanan', () => {
  test('hanya kunci yang diminta, urut waktu naik', async () => {
    const world = harness({ directory: memoryDirectory() })
    const stored = [
      {
        idempotencyKey: 'bk-1',
        record: attempt({ at: 2_000, operation: 'book', attemptNumber: 2 }),
      },
      {
        idempotencyKey: 'bk-1',
        record: attempt({ at: 1_000, operation: 'book', outcome: 'failure', errorKind: 'timeout' }),
      },
      { idempotencyKey: 'bk-2', record: attempt({ at: 1_500, operation: 'book' }) },
    ]

    const response = await request(app(world, stored))
      .get('/ops/suppliers/requests?idempotencyKey=bk-1')
      .set(OPERATOR)

    expect(response.status).toBe(200)
    expect(response.body.data.map((row: { attemptNumber: number }) => row.attemptNumber)).toEqual([
      1, 2,
    ])
    expect(response.body.data[0]).toMatchObject({
      errorKind: 'timeout',
      createdAt: new Date(1_000).toISOString(),
    })
  })

  test('kunci kosong atau hanya spasi ditolak 400', async () => {
    const world = harness({ directory: memoryDirectory() })

    for (const key of ['', '%20%20']) {
      const response = await request(app(world))
        .get(`/ops/suppliers/requests?idempotencyKey=${key}`)
        .set(OPERATOR)
      expect(response.status).toBe(400)
    }
  })
})

describe('PATCH /ops/suppliers/:code — konfigurasi (FR-29)', () => {
  test('operator menonaktifkan supplier lewat rute ops', async () => {
    const directory = memoryDirectory()
    const world = harness({ directory })

    const response = await request(app(world))
      .patch('/ops/suppliers/sky')
      .set(OPERATOR)
      .send({ isActive: false, circuit: { failureThreshold: 3 } })

    expect(response.status).toBe(200)
    expect((await directory.get('SKY'))?.isActive).toBe(false)
    expect((await directory.get('SKY'))?.circuit.failureThreshold).toBe(3)
  })
})
