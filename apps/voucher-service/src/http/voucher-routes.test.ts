import request from 'supertest'
import { describe, expect, test } from 'vitest'
import { issueVoucher } from '../application/issue-voucher.js'
import { SIGNED_URL_TTL_SECONDS } from '../application/voucher-access.js'
import { createVoucherHttpApp, createVoucherMetrics } from '../composition/app.js'
import {
  BOOKING_ID,
  OTHER_USER,
  USER,
  confirmedSource,
  world,
  type World,
} from '../testing/fakes.js'
import { USER_ID_HEADER } from './identity.js'

/**
 * Aplikasi dirangkai lewat factory YANG SAMA dengan produksi — hanya port-nya
 * yang dipalsukan.
 */
function app(w: World) {
  return createVoucherHttpApp({
    deps: w.deps,
    logger: w.deps.logger,
    metrics: createVoucherMetrics('voucher-service-test'),
  })
}

async function issued(): Promise<World> {
  const w = world()
  await issueVoucher(w.deps, BOOKING_ID)
  return w
}

function get(w: World, user: string | undefined, bookingId = BOOKING_ID) {
  const call = request(app(w)).get(`/vouchers/${bookingId}`)
  return user === undefined ? call : call.set(USER_ID_HEADER, user)
}

describe('GET /vouchers/:bookingId', () => {
  test('pemilik menerima URL bertanda tangan berumur pendek', async () => {
    const w = await issued()

    const response = await get(w, USER)

    expect(response.status).toBe(200)
    expect(response.body.data.url).toContain('X-Amz-Expires=300')
    expect(w.storage.signed).toEqual([
      { key: w.vouchers.rows.get(BOOKING_ID)?.objectKey, ttl: SIGNED_URL_TTL_SECONDS },
    ])
    const expiresAt = Date.parse(response.body.data.expiresAt)
    expect(expiresAt - w.clock.value.getTime()).toBe(SIGNED_URL_TTL_SECONDS * 1_000)
  })

  test('URL bertanda tangan tidak boleh disimpan cache', async () => {
    const response = await get(await issued(), USER)

    expect(response.headers['cache-control']).toBe('no-store')
  })

  test('pengguna lain tidak dapat mengakses voucher milik orang lain', async () => {
    const w = await issued()

    const response = await get(w, OTHER_USER)

    // 404, bukan 403: jawaban "dilarang" sudah mengonfirmasi pemesanan itu ada.
    expect(response.status).toBe(404)
    expect(JSON.stringify(response.body)).not.toContain('minio')
    expect(w.storage.signed).toHaveLength(0)
  })

  test('pemesanan belum CONFIRMED menghasilkan galat yang jelas', async () => {
    const w = world({ sources: [confirmedSource({ status: 'HELD', supplierRef: null })] })

    const response = await get(w, USER)

    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('BOOKING_NOT_CONFIRMED')
    expect(response.body.error.message).toContain('belum terkonfirmasi')
  })

  test('pemesanan CONFIRMED yang vouchernya belum terbit dijawab "sedang diterbitkan"', async () => {
    const response = await get(world(), USER)

    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('VOUCHER_NOT_READY')
  })

  test('pemesanan orang lain yang belum bervoucher juga 404, bukan status pemesanannya', async () => {
    const w = world({ sources: [confirmedSource({ status: 'HELD', supplierRef: null })] })

    const response = await get(w, OTHER_USER)

    expect(response.status).toBe(404)
  })

  test('pemesanan yang tidak ada dijawab 404', async () => {
    const response = await get(world({ sources: [] }), USER)

    expect(response.status).toBe(404)
  })

  test.each([
    ['tanpa header', undefined],
    ['bukan UUID', 'admin'],
  ])('%s dijawab 401 sebelum parameter diperiksa', async (_name, header) => {
    const response = await get(world(), header, 'bukan-uuid')

    expect(response.status).toBe(401)
  })

  test('pengenal pemesanan yang bukan UUID dijawab 400', async () => {
    const response = await get(world(), USER, 'bukan-uuid')

    expect(response.status).toBe(400)
  })
})

describe('kesiapan', () => {
  test('siap selama basis data menjawab', async () => {
    const response = await request(app(world())).get('/health/ready')

    expect(response.status).toBe(200)
  })
})
