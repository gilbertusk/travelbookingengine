import request from 'supertest'
import { describe, expect, test } from 'vitest'
import { issueVoucher } from '../application/issue-voucher.js'
import { createVoucherHttpApp, createVoucherMetrics } from '../composition/app.js'
import { BOOKING_ID, world, type World } from '../testing/fakes.js'

function app(w: World) {
  return createVoucherHttpApp({
    deps: w.deps,
    logger: w.deps.logger,
    metrics: createVoucherMetrics('voucher-service-test'),
  })
}

function binary(res: request.Response, done: (error: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = []
  res.on('data', (chunk: Buffer) => chunks.push(chunk))
  res.on('end', () => {
    done(null, Buffer.concat(chunks))
  })
}

describe('GET /internal/vouchers/:bookingId/document', () => {
  test('mengembalikan berkas PDF voucher yang sudah terbit', async () => {
    const w = world()
    await issueVoucher(w.deps, BOOKING_ID)
    const stored = [...w.storage.objects.values()][0]

    const response = await request(app(w))
      .get(`/internal/vouchers/${BOOKING_ID}/document`)
      .buffer(true)
      .parse(binary)

    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toBe('application/pdf')
    expect(response.headers['cache-control']).toBe('no-store')
    expect(Buffer.compare(response.body as Buffer, Buffer.from(stored ?? []))).toBe(0)
  })

  test('voucher yang belum terbit dijawab 404 beramplop NOT_FOUND', async () => {
    const response = await request(app(world())).get(`/internal/vouchers/${BOOKING_ID}/document`)

    expect(response.status).toBe(404)
    expect(response.body.error.code).toBe('NOT_FOUND')
  })

  test('pengenal yang bukan UUID dijawab 400', async () => {
    const response = await request(app(world())).get('/internal/vouchers/abc/document')

    expect(response.status).toBe(400)
  })
})
