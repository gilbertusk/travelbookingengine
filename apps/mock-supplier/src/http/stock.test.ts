import request from 'supertest'
import { describe, expect, test } from 'vitest'
import { MAX_UNITS_PER_NIGHT } from '../domain/availability.js'
import { createHarness, STAY } from '../testing/harness.js'

/**
 * Stok yang ditetapkan lewat panel kendali (Step 22).
 *
 * Ketersediaan dasar dibatasi MAX_UNITS_PER_NIGHT, sedangkan uji beban US-04
 * membutuhkan tepat sepuluh. Stok yang ditetapkan menggantikan ketersediaan
 * dasar SATU rate plan di setiap malam; unit yang ditahan dan terjual tetap
 * mengurangkannya seperti biasa.
 */

type TestApp = ReturnType<typeof createHarness>['app']

async function firstSkyRate(app: TestApp): Promise<{ rateId: string; available: number }> {
  const search = await request(app)
    .post('/sky/availability')
    .send({ city: 'Bali', ...STAY, guests: 2 })
  const rate = search.body.results[0].rooms[0].rates[0]
  return { rateId: String(rate.rateId), available: Number(rate.unitsLeft) }
}

async function hold(app: TestApp, rateId: string): Promise<number> {
  const response = await request(app)
    .post('/sky/holds')
    .send({ rateId, ...STAY, guests: 2 })
  return response.status
}

describe('stok yang ditetapkan', () => {
  test('melampaui batas dasar, dan habis tepat pada jumlahnya', async () => {
    const { app } = createHarness()
    const { rateId } = await firstSkyRate(app)
    const units = MAX_UNITS_PER_NIGHT + 2

    const set = await request(app).post('/admin/sky/stock').send({ rateRef: rateId, units })
    expect(set.status).toBe(200)

    const statuses = []
    for (let index = 0; index < units + 3; index += 1) statuses.push(await hold(app, rateId))

    expect(statuses.filter((status) => status === 201)).toHaveLength(units)
    expect(statuses.slice(units).every((status) => status !== 201)).toBe(true)
  })

  test('terlihat di pencarian, sama seperti ketersediaan dasar', async () => {
    const { app } = createHarness()
    const { rateId } = await firstSkyRate(app)

    await request(app).post('/admin/sky/stock').send({ rateRef: rateId, units: 10 })

    expect((await firstSkyRate(app)).available).toBe(10)
  })

  test('dibersihkan bersama inventaris', async () => {
    const { app } = createHarness()
    const before = await firstSkyRate(app)
    await request(app).post('/admin/sky/stock').send({ rateRef: before.rateId, units: 30 })

    await request(app).post('/admin/inventory/reset').send({})

    expect((await firstSkyRate(app)).available).toBe(before.available)
  })

  test('rate plan yang tidak dikenal ditolak', async () => {
    const { app } = createHarness()

    const response = await request(app)
      .post('/admin/sky/stock')
      .send({ rateRef: 'tak-ada', units: 5 })

    expect(response.status).toBe(400)
  })

  test('jumlah yang tidak sah ditolak', async () => {
    const { app } = createHarness()

    const response = await request(app).post('/admin/sky/stock').send({ rateRef: 'x', units: -1 })

    expect(response.status).toBe(400)
  })
})
