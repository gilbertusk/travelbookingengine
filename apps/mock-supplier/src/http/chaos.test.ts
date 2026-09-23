import request from 'supertest'
import { describe, expect, test } from 'vitest'
import {
  NEUTRAL_CHAOS,
  createChaosRegistry,
  failureFor,
  latencyFor,
  shouldDriftPrice,
} from '../application/chaos.js'
import { SUPPLIER_PROFILES } from '../domain/supplier.js'
import { createHarness, STAY } from '../testing/harness.js'

/**
 * Membuktikan panel kendali kegagalan benar-benar bekerja.
 *
 * Setiap mode di sini akan dipakai sebagai landasan klaim di README: uji beban
 * dengan satu supplier dilambatkan, uji konkurensi dengan supplier dimatikan
 * di tengah pembayaran, uji chaos pada sembilan skenario. Kalau satu mode saja
 * diam-diam tidak berfungsi, klaim yang bersandar padanya menjadi kosong.
 */

const CITY = 'Bali'
const searchBody = { city: CITY, ...STAY, guests: 2 }

type TestApp = ReturnType<typeof createHarness>['app']

/**
 * Menyuntik dengan rate 1 alih-alih menyetel sumber keacakan ke nol.
 * Keacakan nol membuat SELURUH supplier gagal, termasuk yang tidak disuntik,
 * sehingga uji isolasi antar supplier jadi tidak berarti.
 */
async function setFailure(app: TestApp, supplier: string, mode: string): Promise<void> {
  const response = await request(app).post(`/admin/${supplier}/failure`).send({ rate: 1, mode })
  expect(response.status).toBe(200)
}

/**
 * Mengambil badan respons mentah tanpa diurai.
 *
 * Tanpa ini, supertest sendiri yang melempar saat mencoba mengurai JSON rusak,
 * dan pengujian tidak pernah sampai ke assertion-nya. Yang ingin dibuktikan
 * adalah statusnya 200 sementara isinya tidak dapat diurai — persis kondisi
 * yang membuat kegagalan jenis ini berbahaya.
 */
function rawText(req: request.Test): request.Test {
  return req.buffer(true).parse((res, callback) => {
    let data = ''
    res.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8')
    })
    res.on('end', () => {
      callback(null, data)
    })
  })
}

describe('penyuntikan kegagalan', () => {
  test('server_error menghasilkan 500', async () => {
    const { app } = createHarness()
    await setFailure(app, 'sky', 'server_error')

    const response = await request(app).post('/sky/availability').send(searchBody)

    expect(response.status).toBe(500)
  })

  test('unavailable menghasilkan 503 dengan retry-after', async () => {
    const { app } = createHarness()
    await setFailure(app, 'sky', 'unavailable')

    const response = await request(app).post('/sky/availability').send(searchBody)

    expect(response.status).toBe(503)
    expect(response.headers['retry-after']).toBe('5')
  })

  test('malformed menghasilkan 200 dengan isi yang tidak dapat diurai', async () => {
    // Kegagalan paling berbahaya: kode statusnya sehat. Inilah alasan Step 10
    // mewajibkan validasi respons supplier, bukan sekadar memeriksa status.
    const { app } = createHarness()
    await setFailure(app, 'sky', 'malformed')

    const response = await rawText(request(app).post('/sky/availability').send(searchBody))

    expect(response.status).toBe(200)
    expect(() => {
      JSON.parse(String(response.body))
    }).toThrow()
  })

  test('truncated menghasilkan 200 dengan isi terpotong', async () => {
    const { app } = createHarness()
    await setFailure(app, 'sky', 'truncated')

    const response = await rawText(request(app).post('/sky/availability').send(searchBody))

    expect(response.status).toBe(200)
    expect(() => {
      JSON.parse(String(response.body))
    }).toThrow()
  })

  test('malformed pada supplier XML tetap menghasilkan XML yang rusak', async () => {
    const { app } = createHarness()
    await setFailure(app, 'orbit', 'malformed')

    const response = await request(app)
      .post('/orbit/soap')
      .set('SOAPAction', 'Availability')
      .set('Content-Type', 'text/xml')
      .send('<Envelope><Body><AvailabilityRequest></AvailabilityRequest></Body></Envelope>')

    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toContain('text/xml')
    expect(response.text).not.toContain('</Envelope>')
  })

  test('connection_reset memutus koneksi tanpa membalas apa pun', async () => {
    // Supplier yang mati tidak membalas 503 — ia menghilang. Membalas status
    // apa pun di sini akan menyembunyikan seluruh kelas kegagalan jaringan.
    const { app } = createHarness()
    await setFailure(app, 'sky', 'connection_reset')

    await expect(request(app).post('/sky/availability').send(searchBody)).rejects.toThrow()
  })

  test('supplier yang dimatikan memutus koneksi', async () => {
    const { app } = createHarness()
    await request(app).post('/admin/sky/down').send({})

    await expect(request(app).post('/sky/availability').send(searchBody)).rejects.toThrow()
  })

  test('menyalakan kembali memulihkan perilaku normal', async () => {
    const { app } = createHarness()
    await request(app).post('/admin/sky/down').send({})
    await request(app).post('/admin/sky/up').send({})

    const response = await request(app).post('/sky/availability').send(searchBody)

    expect(response.status).toBe(200)
  })

  test('menyalakan kembali juga membersihkan suntikan sebelumnya', async () => {
    // Suntikan yang tertinggal dari skenario sebelumnya adalah penyebab umum
    // uji berikutnya gagal tanpa sebab yang jelas.
    const { app } = createHarness()
    await setFailure(app, 'sky', 'server_error')
    await request(app).post('/admin/sky/up').send({})

    const response = await request(app).post('/sky/availability').send(searchBody)

    expect(response.status).toBe(200)
  })

  test('kegagalan pada satu supplier tidak memengaruhi supplier lain', async () => {
    const { app } = createHarness()
    await setFailure(app, 'sky', 'server_error')

    const luna = await request(app)
      .post('/luna/availability')
      .send({
        q: {
          loc: CITY,
          in: Math.floor(Date.parse(`${STAY.checkIn}T00:00:00Z`) / 1_000),
          out: Math.floor(Date.parse(`${STAY.checkOut}T00:00:00Z`) / 1_000),
          pax: 2,
        },
      })

    expect(luna.status).toBe(200)
  })
})

describe('panel admin', () => {
  test('melaporkan keadaan seluruh supplier', async () => {
    const { app } = createHarness()

    const response = await request(app).get('/admin/state')

    expect(response.status).toBe(200)
    expect(response.body.suppliers).toHaveLength(5)
    expect(response.body.suppliers.map((s: { code: string }) => s.code)).toEqual([
      'SKY',
      'NOVA',
      'ORBIT',
      'LUNA',
      'ZEPH',
    ])
  })

  test('reset mengembalikan seluruh supplier ke normal', async () => {
    const { app } = createHarness()
    await setFailure(app, 'sky', 'server_error')
    await request(app).post('/admin/sky/down').send({})

    await request(app).post('/admin/reset').send({})

    const state = await request(app).get('/admin/state')
    const sky = state.body.suppliers.find((s: { code: string }) => s.code === 'SKY')
    expect(sky.chaos).toEqual(NEUTRAL_CHAOS)
  })

  test('menolak supplier yang tidak dikenal', async () => {
    const { app } = createHarness()

    const response = await request(app).post('/admin/tidakada/down').send({})

    expect(response.status).toBe(404)
  })

  test('menolak rentang latensi yang terbalik', async () => {
    const { app } = createHarness()

    const response = await request(app).post('/admin/sky/latency').send({ min: 900, max: 100 })

    expect(response.status).toBe(400)
  })

  test('menolak mode kegagalan yang tidak dikenal', async () => {
    const { app } = createHarness()

    const response = await request(app)
      .post('/admin/sky/failure')
      .send({ rate: 1, mode: 'meledak' })

    expect(response.status).toBe(400)
    expect(response.body.modes).toContain('timeout')
  })

  test('pengaturan pergeseran harga berlaku', async () => {
    const { app } = createHarness()
    await request(app).post('/admin/sky/price-drift').send({ rate: 1 })

    const search = await request(app).post('/sky/availability').send(searchBody)
    const rateId = search.body.results[0].rooms[0].rates[0].rateId
    const verify = await request(app)
      .post('/sky/rates/verify')
      .send({ rateId, ...STAY })

    expect(verify.body.changed).toBe(true)
  })

  test('reset inventaris mengembalikan ketersediaan', async () => {
    const { app } = createHarness()
    const search = await request(app).post('/sky/availability').send(searchBody)
    const rate = search.body.results[0].rooms[0].rates[0]
    await request(app)
      .post('/sky/holds')
      .send({ rateId: rate.rateId, ...STAY, guests: 2 })

    await request(app).post('/admin/inventory/reset').send({})

    const sesudah = await request(app).post('/sky/availability').send(searchBody)
    const rateSesudah = sesudah.body.results[0].rooms[0].rates.find(
      (r: { rateId: string }) => r.rateId === rate.rateId,
    )
    expect(rateSesudah.unitsLeft).toBe(rate.unitsLeft)
  })
})

describe('keputusan chaos', () => {
  test('latensi berada dalam rentang profil bila tidak ditimpa', () => {
    const [min, max] = SUPPLIER_PROFILES.LUNA.latencyMs

    expect(latencyFor('LUNA', NEUTRAL_CHAOS, () => 0)).toBe(min)
    expect(latencyFor('LUNA', NEUTRAL_CHAOS, () => 1)).toBe(max)
  })

  test('rentang latensi yang ditimpa dipakai', () => {
    const chaos = { ...NEUTRAL_CHAOS, latencyMs: [5_000, 5_000] as const }

    expect(latencyFor('SKY', chaos, () => 0.5)).toBe(5_000)
  })

  test('supplier stabil tidak gagal tanpa suntikan', () => {
    expect(failureFor('SKY', NEUTRAL_CHAOS, () => 0)).toBeUndefined()
  })

  test('supplier tidak stabil gagal sesuai peluang bawaannya', () => {
    // ZEPH sengaja dibuat gagal sekitar 15% tanpa suntikan apa pun.
    expect(failureFor('ZEPH', NEUTRAL_CHAOS, () => 0.01)).toBe('server_error')
    expect(failureFor('ZEPH', NEUTRAL_CHAOS, () => 0.99)).toBeUndefined()
  })

  test('down mengalahkan seluruh pengaturan lain', () => {
    const chaos = { ...NEUTRAL_CHAOS, down: true, failureRate: 0 }

    expect(failureFor('SKY', chaos, () => 0.99)).toBe('connection_reset')
  })

  test('pergeseran harga mengikuti peluang yang ditimpa', () => {
    const chaos = { ...NEUTRAL_CHAOS, priceDriftRate: 1 }

    expect(shouldDriftPrice('SKY', chaos, () => 0.99)).toBe(true)
    expect(shouldDriftPrice('SKY', { ...NEUTRAL_CHAOS, priceDriftRate: 0 }, () => 0)).toBe(false)
  })

  test('registry menyimpan perubahan per supplier tanpa saling memengaruhi', () => {
    const registry = createChaosRegistry()

    registry.patch('SKY', { down: true })

    expect(registry.get('SKY').down).toBe(true)
    expect(registry.get('NOVA').down).toBe(false)
  })
})
