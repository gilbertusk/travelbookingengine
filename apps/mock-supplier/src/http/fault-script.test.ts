import request from 'supertest'
import { describe, expect, test } from 'vitest'
import type { SupplierOperation } from '../application/fault-script.js'
import { createHarness, STAY } from '../testing/harness.js'

/**
 * Kegagalan terjadwal lewat panel kendali (Step 20).
 *
 * Yang dibuktikan: jadwal menyasar SATU operasi, habis setelah dipakai, dan
 * `lose_response` benar-benar menyimpan efeknya sebelum jawabannya dibuang —
 * sifat yang membuat skenario "timeout tetapi pemesanan ternyata ada" dapat
 * ditulis di uji integrasi.
 */

const CITY = 'Bali'

type TestApp = ReturnType<typeof createHarness>['app']

async function schedule(
  app: TestApp,
  supplier: string,
  fault: { operation: SupplierOperation; mode: string; times?: number },
): Promise<void> {
  const response = await request(app).post(`/admin/${supplier}/faults`).send(fault)
  expect(response.status).toBe(200)
}

async function skyHold(app: TestApp): Promise<string> {
  const search = await request(app)
    .post('/sky/availability')
    .send({ city: CITY, ...STAY, guests: 2 })
  const rateId = search.body.results[0].rooms[0].rates[0].rateId
  const held = await request(app)
    .post('/sky/holds')
    .send({ rateId, ...STAY, guests: 2 })
  expect(held.status).toBe(201)

  return String(held.body.holdId)
}

describe('kegagalan terjadwal', () => {
  test('hanya operasi yang dijadwalkan yang gagal, dan hanya sekali', async () => {
    const { app } = createHarness()
    const holdId = await skyHold(app)
    await schedule(app, 'sky', { operation: 'book', mode: 'server_error' })

    // Operasi lain tidak tersentuh.
    const lookup = await request(app).get('/sky/bookings').query({ idempotencyKey: 'k-1' })
    expect(lookup.status).toBe(404)

    const payload = { holdId, guestName: 'Budi', idempotencyKey: 'k-1' }
    const failed = await request(app).post('/sky/bookings').send(payload)
    const retried = await request(app).post('/sky/bookings').send(payload)

    expect(failed.status).toBe(500)
    expect(retried.status).toBe(201)
  })

  test('lose_response menyimpan pemesanan tetapi tidak pernah menjawab', async () => {
    const { app } = createHarness()
    const holdId = await skyHold(app)
    await schedule(app, 'sky', { operation: 'book', mode: 'lose_response' })

    await expect(
      request(app)
        .post('/sky/bookings')
        .send({ holdId, guestName: 'Budi', idempotencyKey: 'hilang-1' })
        .timeout(300),
    ).rejects.toThrow(/Timeout/)

    // Efeknya ada: pencarian lewat kunci yang sama menemukannya. Inilah
    // keadaan US-05 yang harus diadopsi, bukan dipesan ulang.
    const found = await request(app).get('/sky/bookings').query({ idempotencyKey: 'hilang-1' })
    expect(found.status).toBe(200)
    expect(found.body.status).toBe('CONFIRMED')
  })

  test('timeout terjadwal menahan permintaan SEBELUM penangan: tidak ada efek', async () => {
    const { app } = createHarness()
    const holdId = await skyHold(app)
    await schedule(app, 'sky', { operation: 'book', mode: 'timeout' })

    await expect(
      request(app)
        .post('/sky/bookings')
        .send({ holdId, guestName: 'Budi', idempotencyKey: 'tak-sampai' })
        .timeout(300),
    ).rejects.toThrow(/Timeout/)

    const found = await request(app).get('/sky/bookings').query({ idempotencyKey: 'tak-sampai' })
    expect(found.status).toBe(404)
  })

  test('reset membersihkan jadwal yang belum terpakai', async () => {
    const { app } = createHarness()
    await schedule(app, 'sky', { operation: 'search', mode: 'server_error', times: 5 })

    await request(app).post('/admin/reset').send({})

    const state = await request(app).get('/admin/state')
    const sky = state.body.suppliers.find((entry: { code: string }) => entry.code === 'SKY')
    expect(sky.scripted).toEqual([])
    const search = await request(app)
      .post('/sky/availability')
      .send({ city: CITY, ...STAY, guests: 2 })
    expect(search.status).toBe(200)
  })

  test('menolak operasi, mode, dan supplier yang tidak dikenal', async () => {
    const { app } = createHarness()

    const badOperation = await request(app)
      .post('/admin/sky/faults')
      .send({ operation: 'teleport', mode: 'timeout' })
    const badMode = await request(app)
      .post('/admin/sky/faults')
      .send({ operation: 'book', mode: 'meledak' })
    const badSupplier = await request(app)
      .post('/admin/acme/faults')
      .send({ operation: 'book', mode: 'timeout' })

    expect(badOperation.status).toBe(400)
    expect(badMode.status).toBe(400)
    expect(badSupplier.status).toBe(404)
  })
})

/**
 * Setiap supplier menamai operasinya berbeda. Setiap baris menjadwalkan
 * `unavailable` untuk SATU operasi lalu memanggil rutenya: 503 membuktikan
 * pemetaan rute → operasi benar untuk supplier itu.
 */
const ROUTES: readonly {
  readonly supplier: string
  readonly operation: SupplierOperation
  readonly call: (app: TestApp) => request.Test
}[] = [
  { supplier: 'sky', operation: 'lookup', call: (app) => request(app).get('/sky/bookings/x') },
  { supplier: 'sky', operation: 'cancel', call: (app) => request(app).delete('/sky/bookings/x') },
  { supplier: 'sky', operation: 'rate', call: (app) => request(app).post('/sky/rates/verify') },
  { supplier: 'nova', operation: 'search', call: (app) => request(app).post('/nova/search') },
  {
    supplier: 'nova',
    operation: 'book',
    call: (app) => request(app).post('/nova/reservations/confirm'),
  },
  {
    supplier: 'nova',
    operation: 'lookup',
    call: (app) => request(app).get('/nova/reservations/x'),
  },
  { supplier: 'luna', operation: 'hold', call: (app) => request(app).post('/luna/hold') },
  { supplier: 'luna', operation: 'cancel', call: (app) => request(app).post('/luna/void') },
  { supplier: 'luna', operation: 'lookup', call: (app) => request(app).get('/luna/bk') },
  { supplier: 'zeph', operation: 'rate', call: (app) => request(app).post('/zeph/offers/price') },
  {
    supplier: 'zeph',
    operation: 'cancel',
    call: (app) => request(app).post('/zeph/bookings/x/cancel'),
  },
  { supplier: 'zeph', operation: 'book', call: (app) => request(app).post('/zeph/bookings') },
  {
    supplier: 'orbit',
    operation: 'book',
    call: (app) => request(app).post('/orbit/soap').set('SOAPAction', 'Book'),
  },
  {
    supplier: 'orbit',
    operation: 'lookup',
    call: (app) => request(app).post('/orbit/soap').set('SOAPAction', '"Retrieve"'),
  },
]

describe('pemetaan rute ke operasi', () => {
  test.each(ROUTES)(
    '$supplier: rute $operation dikenali',
    async ({ supplier, operation, call }) => {
      const { app } = createHarness()
      await schedule(app, supplier, { operation, mode: 'unavailable' })

      const response = await call(app)

      expect(response.status).toBe(503)
    },
  )
})

describe('umur hold dan daftar reservasi', () => {
  test('umur hold dapat dipendekkan, dan hold yang habis tidak lagi terdaftar', async () => {
    const harness = createHarness({ holdTtlMs: 5_000 })
    await skyHold(harness.app)

    const before = await request(harness.app).get('/admin/reservations')
    expect(before.body.holds).toHaveLength(1)
    expect(before.body.holds[0].expiresAtMs - before.body.holds[0].createdAtMs).toBe(5_000)

    harness.advance(5_000)

    // Tidak ada operasi lain yang menyentuh supplier: daftar itu sendiri yang
    // menyapu hold yang sudah lewat.
    const after = await request(harness.app).get('/admin/reservations')
    expect(after.body.holds).toEqual([])
  })

  test('pemesanan terdaftar, dan hold yang menjadi pemesanan tidak lagi terdaftar', async () => {
    const { app } = createHarness()
    const holdId = await skyHold(app)
    await request(app)
      .post('/sky/bookings')
      .send({ holdId, guestName: 'Budi', idempotencyKey: 'daftar-1' })

    const snapshot = await request(app).get('/admin/reservations')

    expect(snapshot.body.holds).toEqual([])
    expect(snapshot.body.bookings).toHaveLength(1)
    expect(snapshot.body.bookings[0].idempotencyKey).toBe('daftar-1')
  })
})
