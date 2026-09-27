import { money } from '@tbe/money'
import type { Express } from 'express'
import request from 'supertest'
import { describe, expect, test } from 'vitest'
import { createBookingHttpApp } from '../composition/app.js'
import { harness, OTHER_USER, priceCheckRequest, USER, type Harness } from '../testing/fakes.js'
import { USER_ID_HEADER } from './booking-routes.js'

/**
 * Aplikasi dirangkai lewat factory YANG SAMA dengan produksi — hanya port-nya
 * yang dipalsukan. Pola payment-service.
 */
function app(world: Harness): Express {
  return createBookingHttpApp({
    deps: world.deps,
    logger: world.deps.logger,
    serviceName: 'booking-service-test',
  }).app
}

function body(key?: string) {
  const request = key === undefined ? priceCheckRequest() : priceCheckRequest({ key })

  // Identitas TIDAK ada di badan permintaan; ia datang dari header gateway.
  return {
    idempotencyKey: request.idempotencyKey,
    supplier: request.supplier,
    propertyId: request.propertyId,
    city: request.city,
    ratePlanRef: request.ratePlanRef,
    checkIn: request.checkIn,
    checkOut: request.checkOut,
    guest: request.guest,
    displayedTotal: { amountMinor: request.displayedTotal.amountMinor, currency: 'IDR' },
  }
}

async function priceCheck(world: Harness, user = USER) {
  return await request(app(world))
    .post('/bookings/price-check')
    .set(USER_ID_HEADER, user)
    .send(body())
}

describe('identitas dari gateway', () => {
  test.each([
    ['tanpa header', undefined],
    ['bukan UUID', 'admin'],
  ])('%s dijawab 401 sebelum isi permintaan diperiksa', async (_name, header) => {
    const world = harness()
    const call = request(app(world)).post('/bookings/price-check')

    const response = await (header === undefined ? call : call.set(USER_ID_HEADER, header)).send({})

    expect(response.status).toBe(401)
  })
})

describe('POST /bookings/price-check', () => {
  test('harga tidak berubah: 200 dengan rincian harga jual', async () => {
    const response = await priceCheck(harness())

    expect(response.status).toBe(200)
    expect(response.body.data).toMatchObject({
      status: 'PRICE_CHECKED',
      checkIn: '2026-11-10',
      priceCheck: { outcome: 'unchanged', price: { amountMinor: 2_442_000, currency: 'IDR' } },
    })
    expect(response.body.data.price.lineItems).toHaveLength(2)
  })

  test('respons tidak membawa kunci idempotensi, versi, maupun data tamu', async () => {
    const response = await priceCheck(harness())

    expect(Object.keys(response.body.data)).not.toEqual(expect.arrayContaining(['idempotencyKey']))
    expect(JSON.stringify(response.body)).not.toContain('sari@example.com')
    expect(response.body.data).not.toHaveProperty('version')
  })

  /**
   * Rate Change adalah kondisi normal (glosarium PRD), jadi 200 — bukan 409.
   * Harga lama, harga baru, dan selisihnya eksplisit (US-02).
   */
  test('harga berubah: 200 dengan harga lama, baru, dan selisihnya', async () => {
    const world = harness()
    world.suppliers.supplierTotal = money(2_100_000, 'IDR')

    const response = await priceCheck(world)

    expect(response.status).toBe(200)
    expect(response.body.data.priceCheck).toEqual({
      outcome: 'changed',
      previous: { amountMinor: 2_442_000, currency: 'IDR' },
      current: { amountMinor: 2_564_100, currency: 'IDR' },
      difference: { amountMinor: 122_100, currency: 'IDR' },
    })
  })

  test('rate plan habis: 409 RATE_UNAVAILABLE', async () => {
    const world = harness()
    world.suppliers.nextPrice({ kind: 'rejected', reason: 'sold_out' })

    const response = await priceCheck(world)

    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('RATE_UNAVAILABLE')
  })

  test('supplier belum menjawab: 503', async () => {
    const world = harness()
    world.suppliers.nextPrice({ kind: 'unreachable' })

    expect((await priceCheck(world)).status).toBe(503)
  })

  test('masukan domain tidak sah: 400', async () => {
    const response = await request(app(harness()))
      .post('/bookings/price-check')
      .set(USER_ID_HEADER, USER)
      .send({ ...body(), checkOut: '2026-11-09' })

    expect(response.status).toBe(400)
  })

  test('kunci yang sama untuk pemesanan lain: 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const world = harness()
    await priceCheck(world)

    const response = await request(app(world))
      .post('/bookings/price-check')
      .set(USER_ID_HEADER, USER)
      .send({ ...body(), ratePlanRef: 'SKY-RP-STD' })

    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED')
  })
})

describe('POST /bookings/price-check/accept', () => {
  test('persetujuan lalu price check ulang: 200 terverifikasi dengan harga baru', async () => {
    const world = harness()
    world.suppliers.supplierTotal = money(2_100_000, 'IDR')
    const created = await priceCheck(world)

    const response = await request(app(world))
      .post('/bookings/price-check/accept')
      .set(USER_ID_HEADER, USER)
      .send({ bookingId: created.body.data.id })

    expect(response.status).toBe(200)
    expect(response.body.data.priceCheck).toEqual({
      outcome: 'unchanged',
      price: { amountMinor: 2_564_100, currency: 'IDR' },
    })
  })

  test('tanpa perubahan harga: 409 dari aturan domain', async () => {
    const world = harness()
    const created = await priceCheck(world)

    const response = await request(app(world))
      .post('/bookings/price-check/accept')
      .set(USER_ID_HEADER, USER)
      .send({ bookingId: created.body.data.id })

    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('BOOKING_RULE_VIOLATION')
  })

  test('pemesanan orang lain: 404', async () => {
    const world = harness()
    const created = await priceCheck(world)

    const response = await request(app(world))
      .post('/bookings/price-check/accept')
      .set(USER_ID_HEADER, OTHER_USER)
      .send({ bookingId: created.body.data.id })

    expect(response.status).toBe(404)
  })
})

describe('POST /bookings/hold', () => {
  async function holdCall(world: Harness, bookingId: string, user = USER) {
    return await request(app(world))
      .post('/bookings/hold')
      .set(USER_ID_HEADER, user)
      .send({ bookingId, unitsLeft: 1 })
  }

  test('hold berhasil: 200 HELD dengan batas waktunya', async () => {
    const world = harness()
    const created = await priceCheck(world)

    const response = await holdCall(world, created.body.data.id)

    expect(response.status).toBe(200)
    expect(response.body.data.status).toBe('HELD')
    expect(response.body.data.heldUntil).toBe('2026-10-01T03:15:00.000Z')
  })

  test('kursi habis: 409 SOLD_OUT', async () => {
    const world = harness()
    const first = await priceCheck(world)
    await holdCall(world, first.body.data.id)
    const second = await request(app(world))
      .post('/bookings/price-check')
      .set(USER_ID_HEADER, USER)
      .send(body('req-2026-10-01-0002'))

    const response = await holdCall(world, second.body.data.id)

    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('SOLD_OUT')
  })

  test('harga berubah saat hold: 409 PRICE_CHANGED', async () => {
    const world = harness()
    const created = await priceCheck(world)
    world.suppliers.nextHold({
      kind: 'ok',
      value: { holdRef: 'h', expiresAt: new Date('2026-10-01T04:00:00Z'), total: money(1, 'IDR') },
    })

    const response = await holdCall(world, created.body.data.id)

    expect(response.body.error.code).toBe('PRICE_CHANGED')
  })

  test('supplier belum menjawab: 503', async () => {
    const world = harness()
    const created = await priceCheck(world)
    world.suppliers.nextHold({ kind: 'unreachable' })

    expect((await holdCall(world, created.body.data.id)).status).toBe(503)
  })

  test('harga belum disetujui: 409 dari aturan domain', async () => {
    const world = harness()
    world.suppliers.supplierTotal = money(2_100_000, 'IDR')
    const created = await priceCheck(world)

    const response = await holdCall(world, created.body.data.id)

    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('BOOKING_RULE_VIOLATION')
  })

  /**
   * Deterministik, bukan dua permintaan HTTP serentak. Versi pertama mengirim
   * dua permintaan bersamaan dan mengharapkan satu 409; keduanya 200, karena
   * yang kedua tiba setelah yang pertama selesai dan dijawab sebagai
   * pengulangan yang sah. Balapan sesungguhnya diuji di place-hold.test.ts;
   * yang diuji di sini hanya pemetaan statusnya.
   */
  test('hold yang sedang diproses permintaan lain: 409 HOLD_IN_PROGRESS', async () => {
    const world = harness()
    const created = await priceCheck(world)
    const id: string = created.body.data.id
    await world.deps.holds.acquire({
      bookingId: id,
      slot: 'SKY|SKY-RP-DLX-BB|2026-11-10|2026-11-12',
      capacity: 5,
      until: new Date('2026-10-01T03:15:00Z'),
    })

    const response = await holdCall(world, id)

    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('HOLD_IN_PROGRESS')
  })

  test('pemesanan orang lain: 404', async () => {
    const world = harness()
    const created = await priceCheck(world)

    expect((await holdCall(world, created.body.data.id, OTHER_USER)).status).toBe(404)
  })
})

describe('tampilan hasil price check', () => {
  test('harga berpindah mata uang: selisih null, bukan angka lintas mata uang', async () => {
    const world = harness()
    world.suppliers.supplierTotal = money(15_000, 'USD')

    const response = await priceCheck(world)

    expect(response.body.data.priceCheck).toMatchObject({
      outcome: 'changed',
      current: { currency: 'USD' },
      difference: null,
    })
  })

  test('persetujuan yang verifikasi ulangnya belum terjawab terlihat sebagai awaiting_recheck', async () => {
    const world = harness()
    world.suppliers.supplierTotal = money(2_100_000, 'IDR')
    const created = await priceCheck(world)
    world.suppliers.nextPrice({ kind: 'unreachable' })
    const id = String(created.body.data.id)

    const accepted = await request(app(world))
      .post('/bookings/price-check/accept')
      .set(USER_ID_HEADER, USER)
      .send({ bookingId: id })
    const view = await request(app(world)).get(`/bookings/${id}`).set(USER_ID_HEADER, USER)

    expect(accepted.status).toBe(503)
    expect(view.body.data.priceCheck).toEqual({ outcome: 'awaiting_recheck' })
  })
})

describe('GET /bookings/:id', () => {
  test('pemilik melihat pemesanannya', async () => {
    const world = harness()
    const created = await priceCheck(world)

    const response = await request(app(world))
      .get(`/bookings/${String(created.body.data.id)}`)
      .set(USER_ID_HEADER, USER)

    expect(response.status).toBe(200)
    expect(response.body.data.id).toBe(created.body.data.id)
  })

  test('pengguna lain memperoleh 404, sama dengan pemesanan yang tidak ada', async () => {
    const world = harness()
    const created = await priceCheck(world)

    const other = await request(app(world))
      .get(`/bookings/${String(created.body.data.id)}`)
      .set(USER_ID_HEADER, OTHER_USER)
    const missing = await request(app(world))
      .get('/bookings/00000000-0000-4000-8000-00000000ffff')
      .set(USER_ID_HEADER, USER)

    expect(other.status).toBe(404)
    expect(other.body.error.code).toBe(missing.body.error.code)
  })

  test('pengenal yang bukan UUID: 400', async () => {
    const response = await request(app(harness())).get('/bookings/abc').set(USER_ID_HEADER, USER)

    expect(response.status).toBe(400)
  })
})

describe('kesehatan', () => {
  test('siap bila basis data dapat dihubungi', async () => {
    const response = await request(app(harness())).get('/health/ready')

    expect(response.status).toBe(200)
  })
})
