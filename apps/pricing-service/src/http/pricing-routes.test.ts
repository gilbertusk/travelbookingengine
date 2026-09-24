import { createLogger } from '@tbe/shared-kernel'
import { money } from '@tbe/money'
import request from 'supertest'
import { describe, expect, test } from 'vitest'
import { createPricingHttpApp } from '../composition/app.js'
import { fixedRule, harness, percentageRule } from '../testing/fakes.js'

/**
 * Antarmuka internal.
 *
 * Dirangkai lewat factory yang sama dengan produksi — hanya port-nya yang
 * dipalsukan. Aplikasi uji yang dirangkai sendiri akan berbeda dari yang
 * sesungguhnya, dan perbedaannya selalu ada di tempat yang tidak diduga.
 */

const logger = createLogger({ serviceName: 'pricing-service-test', level: 'silent' })

function appWith(world: ReturnType<typeof harness>) {
  return createPricingHttpApp({ deps: world.deps, logger, serviceName: 'pricing-service' }).app
}

function item(overrides: Record<string, unknown> = {}) {
  return {
    ref: 'rp-1',
    supplier: 'SKY',
    city: 'Bali',
    supplierTotal: money(1_000_000, 'IDR'),
    ...overrides,
  }
}

describe('penetapan harga rate plan', () => {
  test('mengembalikan rincian harga, bukan hanya totalnya', async () => {
    // Rp 1.000.000 × 1,15 = Rp 1.150.000 ; PPN 11% = Rp 126.500
    // Total = Rp 1.276.500
    const world = harness({ rules: [percentageRule({ percentageBasisPoints: 1_500 })] })

    const response = await request(appWith(world))
      .post('/internal/pricing/rate-plans')
      .send({ items: [item()] })

    expect(response.status).toBe(200)
    const [priced] = response.body.data.priced
    expect(priced.breakdown.base.amountMinor).toBe(1_000_000)
    expect(priced.breakdown.markup.amountMinor).toBe(150_000)
    expect(priced.breakdown.tax.amountMinor).toBe(126_500)
    expect(priced.breakdown.total.amountMinor).toBe(1_276_500)
  })

  test('item yang gagal dipisahkan dari yang berhasil, bukan menggagalkan semuanya', async () => {
    // Satu kurs yang hilang untuk satu supplier tidak boleh menghapus hasil
    // dari supplier lain.
    const world = harness({ rates: [] })

    const response = await request(appWith(world))
      .post('/internal/pricing/rate-plans')
      .send({
        items: [item({ ref: 'idr' }), item({ ref: 'usd', supplierTotal: money(10_000, 'USD') })],
      })

    expect(response.status).toBe(200)
    expect(response.body.data.priced).toHaveLength(1)
    expect(response.body.data.failed).toHaveLength(1)
    expect(response.body.data.failed[0].ref).toBe('usd')
  })

  test('kurs yang dipakai ikut dikembalikan untuk penelusuran', async () => {
    const world = harness()

    const response = await request(appWith(world))
      .post('/internal/pricing/rate-plans')
      .send({ items: [item()] })

    expect(response.body.data.ratesUsed[0].from).toBe('USD')
    expect(response.body.data.ratesUsed[0].asOf).toBe('2026-09-01T00:00:00.000Z')
  })

  test('daftar kosong ditolak, bukan dijawab dengan hasil kosong', async () => {
    // Permintaan tanpa item adalah kekeliruan pemanggil. Menjawabnya dengan
    // 200 berisi daftar kosong menyembunyikan kekeliruan itu.
    const response = await request(appWith(harness()))
      .post('/internal/pricing/rate-plans')
      .send({ items: [] })

    expect(response.status).toBe(400)
  })

  test('supplier di luar daftar ditolak', async () => {
    const response = await request(appWith(harness()))
      .post('/internal/pricing/rate-plans')
      .send({ items: [item({ supplier: 'TIDAK_ADA' })] })

    expect(response.status).toBe(400)
  })

  test('harga supplier tanpa mata uang ditolak', async () => {
    const response = await request(appWith(harness()))
      .post('/internal/pricing/rate-plans')
      .send({ items: [item({ supplierTotal: { amountMinor: 1_000_000 } })] })

    expect(response.status).toBe(400)
  })

  test('harga supplier berupa angka biasa ditolak', async () => {
    // Inilah yang dijaga tipe Money di dalam kode, dijaga juga di batas HTTP:
    // angka telanjang tidak menyebut mata uang apa pun.
    const response = await request(appWith(harness()))
      .post('/internal/pricing/rate-plans')
      .send({ items: [item({ supplierTotal: 1_000_000 })] })

    expect(response.status).toBe(400)
  })

  test('permintaan melebihi batas jumlah rate plan ditolak', async () => {
    const items = Array.from({ length: 2_001 }, (_, index) => item({ ref: `rp-${String(index)}` }))

    const response = await request(appWith(harness()))
      .post('/internal/pricing/rate-plans')
      .send({ items })

    expect(response.status).toBe(400)
  })
})

describe('kurs', () => {
  test('dapat dibaca untuk keperluan pemeriksaan', async () => {
    const response = await request(appWith(harness())).get('/internal/pricing/rates')

    expect(response.status).toBe(200)
    expect(response.body.data).toHaveLength(1)
  })
})

describe('kesiapan', () => {
  test('tanpa kurs, service menyatakan diri belum siap', async () => {
    // Tanpa kurs, setiap harga dalam dolar gagal dihitung. Gagal diam-diam
    // untuk sebagian hasil jauh lebih buruk daripada menyatakan belum siap.
    const response = await request(appWith(harness({ rates: [] }))).get('/health/ready')

    expect(response.status).toBe(503)
  })

  test('dengan kurs, service menyatakan siap', async () => {
    const response = await request(appWith(harness())).get('/health/ready')

    expect(response.status).toBe(200)
  })
})

describe('pengelolaan aturan markup', () => {
  test('aturan baru dikembalikan beserta pengenalnya', async () => {
    const response = await request(appWith(harness()))
      .post('/internal/pricing/markup-rules')
      .send({ name: 'markup Bali', kind: 'percentage', percentageBasisPoints: 1_200 })

    expect(response.status).toBe(201)
    expect(response.body.data.id).toBeDefined()
    expect(response.body.data.percentageBasisPoints).toBe(1_200)
  })

  test('aturan persentase tanpa angka persentasenya ditolak saat dibuat', async () => {
    // Ditolak di sini, bukan diam-diam menjadi "tanpa markup" saat dipakai.
    // Aturan yang tersimpan tetapi tidak pernah berlaku adalah aturan yang
    // operatornya yakin sedang berjalan.
    const response = await request(appWith(harness()))
      .post('/internal/pricing/markup-rules')
      .send({ name: 'rusak', kind: 'percentage' })

    expect(response.status).toBe(400)
  })

  test('aturan nominal tanpa nominalnya ditolak saat dibuat', async () => {
    const response = await request(appWith(harness()))
      .post('/internal/pricing/markup-rules')
      .send({ name: 'rusak', kind: 'fixed' })

    expect(response.status).toBe(400)
  })

  test('aturan nominal tetap diterima beserta jumlahnya', async () => {
    const response = await request(appWith(harness()))
      .post('/internal/pricing/markup-rules')
      .send({ name: 'nominal', kind: 'fixed', fixedAmount: money(50_000, 'IDR') })

    expect(response.status).toBe(201)
    expect(response.body.data.fixedAmount).toEqual({ amountMinor: 50_000, currency: 'IDR' })
  })

  test('seluruh aturan dapat dilihat, termasuk yang nonaktif', async () => {
    // Daftar yang hanya menampilkan aturan aktif membuat operator mengira
    // aturan yang dinonaktifkan sudah hilang, lalu membuatnya lagi.
    const world = harness({
      rules: [percentageRule({ id: 'aktif' }), fixedRule({ id: 'mati', isActive: false })],
    })

    const response = await request(appWith(world)).get('/internal/pricing/markup-rules')

    expect(response.status).toBe(200)
    expect(response.body.data).toHaveLength(2)
  })

  test('perubahan aturan dikembalikan apa adanya', async () => {
    const world = harness({ rules: [percentageRule({ id: 'rule-default' })] })

    const response = await request(appWith(world))
      .patch('/internal/pricing/markup-rules/rule-default')
      .send({ percentageBasisPoints: 2_000 })

    expect(response.status).toBe(200)
    expect(response.body.data.percentageBasisPoints).toBe(2_000)
  })

  test('perubahan pada aturan yang tidak ada dibalas 404', async () => {
    const response = await request(appWith(harness()))
      .patch('/internal/pricing/markup-rules/tidak-ada')
      .send({ priority: 5 })

    expect(response.status).toBe(404)
  })

  test('penghapusan aturan menonaktifkannya, bukan menghilangkannya', async () => {
    // Harga pemesanan lama merujuk aturan yang dipakai saat itu. Aturan yang
    // benar-benar hilang membuat harga lama tidak dapat dijelaskan lagi.
    const world = harness({ rules: [percentageRule({ id: 'rule-default' })] })
    const app = appWith(world)

    const removed = await request(app).delete('/internal/pricing/markup-rules/rule-default')
    expect(removed.status).toBe(200)
    expect(removed.body.data.isActive).toBe(false)

    const listed = await request(app).get('/internal/pricing/markup-rules')
    expect(listed.body.data).toHaveLength(1)
    expect(listed.body.data[0].isActive).toBe(false)
  })

  test('penghapusan aturan yang tidak ada dibalas 404', async () => {
    const response = await request(appWith(harness())).delete(
      '/internal/pricing/markup-rules/tidak-ada',
    )

    expect(response.status).toBe(404)
  })

  test('basis poin di luar batas wajar ditolak', async () => {
    const response = await request(appWith(harness()))
      .post('/internal/pricing/markup-rules')
      .send({ name: 'keliru', kind: 'percentage', percentageBasisPoints: 100_001 })

    expect(response.status).toBe(400)
  })

  test('basis poin pecahan ditolak', async () => {
    // `0.125` yang tersimpan sebagai pecahan adalah cara paling halus membuat
    // markup meleset; basis poin harus bilangan bulat.
    const response = await request(appWith(harness()))
      .post('/internal/pricing/markup-rules')
      .send({ name: 'keliru', kind: 'percentage', percentageBasisPoints: 12.5 })

    expect(response.status).toBe(400)
  })

  test('aturan yang baru dibuat langsung berlaku pada penetapan harga', async () => {
    // Membuktikan bahwa aturan benar-benar tersimpan, bukan hanya dibalas.
    const world = harness()
    const app = appWith(world)

    await request(app)
      .post('/internal/pricing/markup-rules')
      .send({ name: 'baru', kind: 'percentage', percentageBasisPoints: 1_000 })

    const priced = await request(app)
      .post('/internal/pricing/rate-plans')
      .send({ items: [item()] })

    expect(priced.body.data.priced[0].breakdown.markup.amountMinor).toBe(100_000)
  })
})
