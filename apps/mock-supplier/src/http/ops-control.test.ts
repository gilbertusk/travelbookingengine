import { USER_ID_HEADER, USER_ROLE_HEADER } from '@tbe/shared-kernel'
import request from 'supertest'
import { describe, expect, test } from 'vitest'
import { createHarness, STAY } from '../testing/harness.js'

/**
 * Panel kendali lewat /ops (Step 27, FR-32): penjagaan peran, dan bukti bahwa
 * suntikan dari panel operator mengenai keadaan YANG SAMA dengan /admin —
 * bukan salinan yang tidak dibaca apa pun.
 */

const SEARCH = { city: 'Bali', ...STAY, guests: 2 }
const OPERATOR = { [USER_ID_HEADER]: 'user-ops', [USER_ROLE_HEADER]: 'operator' }

describe('/ops/mock-supplier', () => {
  test('tanpa identitas 401, pelanggan 403, dan supplier tetap menyala', async () => {
    const { app } = createHarness()

    expect((await request(app).post('/ops/mock-supplier/sky/down')).status).toBe(401)
    const customer = await request(app)
      .post('/ops/mock-supplier/sky/down')
      .set(USER_ID_HEADER, 'user-1')
      .set(USER_ROLE_HEADER, 'customer')
    expect(customer.status).toBe(403)

    const state = await request(app).get('/admin/state')
    const sky = state.body.suppliers.find((row: { code: string }) => row.code === 'SKY')
    expect(sky.chaos.down).toBe(false)
  })

  test('operator mematikan SKY dari panel: koneksi SKY diputus sampai dinyalakan kembali', async () => {
    const { app } = createHarness()

    const down = await request(app).post('/ops/mock-supplier/sky/down').set(OPERATOR)
    expect(down.status).toBe(200)

    // "Mati" berarti koneksi diputus — persis yang dilihat adapter saat supplier tumbang.
    await expect(request(app).post('/sky/availability').send(SEARCH)).rejects.toThrow()
    const state = await request(app).get('/ops/mock-supplier/state').set(OPERATOR)
    expect(
      state.body.suppliers.find((row: { code: string }) => row.code === 'SKY').chaos.down,
    ).toBe(true)

    const up = await request(app).post('/ops/mock-supplier/sky/up').set(OPERATOR)
    expect(up.status).toBe(200)
    expect((await request(app).get('/admin/state')).body.suppliers[0].chaos.down).toBe(false)
    expect((await request(app).post('/sky/availability').send(SEARCH)).status).toBe(200)
  })
})
