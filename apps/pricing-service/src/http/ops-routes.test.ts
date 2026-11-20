import { USER_ID_HEADER, USER_ROLE_HEADER, createLogger } from '@tbe/shared-kernel'
import { money } from '@tbe/money'
import request from 'supertest'
import { describe, expect, test } from 'vitest'
import { createPricingHttpApp } from '../composition/app.js'
import { harness, percentageRule } from '../testing/fakes.js'

const logger = createLogger({ serviceName: 'pricing-service-test', level: 'silent' })
const OPERATOR = { [USER_ID_HEADER]: 'user-ops', [USER_ROLE_HEADER]: 'operator' }
const PREVIEW = '/ops/pricing/markup-rules/preview'

function appWith(world: ReturnType<typeof harness>) {
  return createPricingHttpApp({ deps: world.deps, logger, serviceName: 'pricing-service' }).app
}

const SAMPLES = [
  { ref: 'sky-bali', supplier: 'SKY', city: 'Bali', supplierTotal: money(1_000_000, 'IDR') },
  { ref: 'nova-jkt', supplier: 'NOVA', city: 'Jakarta', supplierTotal: money(1_000_000, 'IDR') },
]

describe('penjagaan /ops/pricing di service', () => {
  test('tanpa identitas 401 — termasuk pratinjau yang tidak menulis', async () => {
    const app = appWith(harness())

    expect((await request(app).get('/ops/pricing/markup-rules')).status).toBe(401)
    expect((await request(app).post(PREVIEW).send({})).status).toBe(401)
  })

  test('pelanggan 403, dan tidak meninggalkan aturan', async () => {
    const world = harness()

    const response = await request(appWith(world))
      .post('/ops/pricing/markup-rules')
      .set(USER_ID_HEADER, 'user-1')
      .set(USER_ROLE_HEADER, 'customer')
      .send({ name: 'diam-diam', kind: 'percentage', percentageBasisPoints: 9_000 })

    expect(response.status).toBe(403)
    expect(await world.rules.listAll()).toEqual([])
  })
})

describe('CRUD operator', () => {
  test('membuat, membaca, mengubah, lalu menonaktifkan', async () => {
    const app = appWith(harness())

    const created = await request(app)
      .post('/ops/pricing/markup-rules')
      .set(OPERATOR)
      .send({
        name: 'Bali 20%',
        kind: 'percentage',
        percentageBasisPoints: 2_000,
        scope: { city: 'Bali' },
      })
    expect(created.status).toBe(201)
    const id: string = created.body.data.id

    const listed = await request(app).get('/ops/pricing/markup-rules').set(OPERATOR)
    expect(listed.body.data).toHaveLength(1)

    const updated = await request(app)
      .patch(`/ops/pricing/markup-rules/${id}`)
      .set(OPERATOR)
      .send({ percentageBasisPoints: 1_000 })
    expect(updated.body.data.percentageBasisPoints).toBe(1_000)

    const removed = await request(app).delete(`/ops/pricing/markup-rules/${id}`).set(OPERATOR)
    expect(removed.body.data).toEqual({ id, isActive: false })
  })
})

describe('POST /ops/pricing/markup-rules/preview', () => {
  test('aturan kota baru: hanya sampel di kota itu yang berubah, dan tidak ada yang tersimpan', async () => {
    // Sebelum: global 10% → 1.100.000 + PPN 11% = 1.221.000 untuk keduanya.
    // Sesudah: Bali 20% → 1.200.000 + PPN = 1.332.000; Jakarta tetap.
    const world = harness({
      rules: [percentageRule({ id: 'r-global', percentageBasisPoints: 1_000 })],
    })

    const response = await request(appWith(world))
      .post(PREVIEW)
      .set(OPERATOR)
      .send({
        change: {
          kind: 'create',
          rule: {
            name: 'Bali',
            kind: 'percentage',
            percentageBasisPoints: 2_000,
            scope: { city: 'Bali' },
          },
        },
        samples: SAMPLES,
      })

    expect(response.status).toBe(200)
    const [bali, jakarta] = response.body.data.rows
    expect(bali.before.total.amountMinor).toBe(1_221_000)
    expect(bali.after.total.amountMinor).toBe(1_332_000)
    expect(bali.isChanged).toBe(true)
    expect(jakarta.isChanged).toBe(false)
    expect(response.body.data.changedCount).toBe(1)
    expect(await world.rules.listAll()).toHaveLength(1)
  })

  test('menonaktifkan satu-satunya aturan: markup turun ke nol untuk semua sampel', async () => {
    const world = harness({ rules: [percentageRule({ id: 'r-global' })] })

    const response = await request(appWith(world))
      .post(PREVIEW)
      .set(OPERATOR)
      .send({ change: { kind: 'deactivate', id: 'r-global' }, samples: SAMPLES })

    expect(response.body.data.changedCount).toBe(2)
    expect(response.body.data.rows[0].after).toMatchObject({
      ruleId: null,
      markup: { amountMinor: 0 },
    })
    expect((await world.rules.listAll())[0]?.isActive).toBe(true)
  })

  test('mengaktifkan kembali aturan NONAKTIF — butuh daftar lengkap, bukan hanya yang aktif', async () => {
    const world = harness({
      rules: [percentageRule({ id: 'r-mati', isActive: false, percentageBasisPoints: 5_000 })],
    })

    const response = await request(appWith(world))
      .post(PREVIEW)
      .set(OPERATOR)
      .send({
        change: { kind: 'update', id: 'r-mati', patch: { isActive: true } },
        samples: SAMPLES,
      })

    expect(response.status).toBe(200)
    expect(response.body.data.rows[0].after.ruleId).toBe('r-mati')
  })

  test('sampel yang gagal dihitung dilaporkan per baris, tidak menggagalkan pratinjau', async () => {
    const world = harness({ rates: [] })

    const response = await request(appWith(world))
      .post(PREVIEW)
      .set(OPERATOR)
      .send({
        change: {
          kind: 'create',
          rule: { name: 'x', kind: 'percentage', percentageBasisPoints: 100 },
        },
        samples: [
          { ref: 'usd', supplier: 'SKY', city: 'Bali', supplierTotal: money(10_000, 'USD') },
        ],
      })

    expect(response.status).toBe(200)
    expect(response.body.data.rows[0]).toMatchObject({
      before: { ok: false, error: { kind: 'missing_exchange_rate' } },
      after: { ok: false },
      isChanged: false,
    })
  })

  test('aturan yang tidak ada: 404; aturan tidak lengkap: 400', async () => {
    const app = appWith(harness())

    const missing = await request(app)
      .post(PREVIEW)
      .set(OPERATOR)
      .send({ change: { kind: 'deactivate', id: 'hilang' }, samples: SAMPLES })
    const incomplete = await request(app)
      .post(PREVIEW)
      .set(OPERATOR)
      .send({ change: { kind: 'create', rule: { name: 'x', kind: 'fixed' } }, samples: SAMPLES })

    expect(missing.status).toBe(404)
    expect(incomplete.status).toBe(400)
  })

  test('aturan nominal dengan cakupan supplier ikut dipratinjau', async () => {
    const response = await request(appWith(harness()))
      .post(PREVIEW)
      .set(OPERATOR)
      .send({
        change: {
          kind: 'create',
          rule: {
            name: 'SKY tetap',
            kind: 'fixed',
            fixedAmount: money(50_000, 'IDR'),
            scope: { supplier: 'SKY' },
          },
        },
        samples: SAMPLES,
      })

    expect(response.body.data.rows.map((row: { isChanged: boolean }) => row.isChanged)).toEqual([
      true,
      false,
    ])
  })
})
