import { createLogger } from '@tbe/shared-kernel'
import request from 'supertest'
import { describe, expect, test } from 'vitest'
import { createSupplierHttpApp } from '../composition/app.js'
import { booking, err, failure, harness, memoryDirectory, ok } from '../testing/fakes.js'

/**
 * Antarmuka internal.
 *
 * Dirangkai lewat factory yang sama dengan produksi — hanya port-nya yang
 * dipalsukan. Aplikasi uji yang dirangkai sendiri akan berbeda dari yang
 * sesungguhnya, dan perbedaannya selalu ada di tempat yang tidak diduga.
 */

const logger = createLogger({ serviceName: 'supplier-service-test', level: 'silent' })

function appWith(world: ReturnType<typeof harness>) {
  return createSupplierHttpApp({ deps: world.deps, logger, serviceName: 'supplier-service' }).app
}

const CONFIRM_BODY = {
  supplier: 'SKY',
  holdRef: 'hld_1',
  guestName: 'Budi Santoso',
  idempotencyKey: 'kunci-1',
}

describe('konfirmasi pemesanan', () => {
  test('pemesanan berhasil dibalas beserta referensinya', async () => {
    const world = harness({ script: { book: [ok(booking('SKY', 'bkg_1'))] } })

    const response = await request(appWith(world))
      .post('/internal/suppliers/confirm')
      .send(CONFIRM_BODY)

    expect(response.status).toBe(200)
    expect(response.body.data.status).toBe('confirmed')
    expect(response.body.data.booking.bookingReference).toBe('bkg_1')
  })

  test('pemesanan yang diadopsi ditandai sebagai adopsi', async () => {
    const world = harness({
      script: {
        book: [err(failure('SKY', 'book', 'timeout'))],
        lookup: [ok(booking('SKY', 'bkg_ada'))],
      },
    })

    const response = await request(appWith(world))
      .post('/internal/suppliers/confirm')
      .send(CONFIRM_BODY)

    expect(response.status).toBe(200)
    expect(response.body.data.adopted).toBe(true)
  })

  test('status yang tidak pasti dibalas 202, bukan 500', async () => {
    // 500 akan membuat pemanggil mencobanya lagi — tepat hal yang seluruh
    // mekanisme ini ada untuk mencegahnya.
    const world = harness({
      script: {
        book: [err(failure('SKY', 'book', 'timeout'))],
        lookup: [err(failure('SKY', 'getBooking', 'timeout'))],
      },
    })

    const response = await request(appWith(world))
      .post('/internal/suppliers/confirm')
      .send(CONFIRM_BODY)

    expect(response.status).toBe(202)
    expect(response.body.data.status).toBe('uncertain')
    expect(response.body.data.idempotencyKey).toBe('kunci-1')
  })

  test('kamar habis dibalas 409', async () => {
    const world = harness({ script: { book: [err(failure('SKY', 'book', 'sold_out'))] } })

    const response = await request(appWith(world))
      .post('/internal/suppliers/confirm')
      .send(CONFIRM_BODY)

    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('SOLD_OUT')
  })

  test('kunci idempotensi wajib ada', async () => {
    const world = harness({ script: { book: [ok(booking('SKY', 'bkg_1'))] } })

    const response = await request(appWith(world))
      .post('/internal/suppliers/confirm')
      .send({ supplier: 'SKY', holdRef: 'h', guestName: 'B' })

    expect(response.status).toBe(400)
    expect(world.gateway.calls).toHaveLength(0)
  })
})

describe('pemetaan kegagalan ke status', () => {
  test('batas waktu menjadi 504', async () => {
    const world = harness({ script: { hold: [err(failure('SKY', 'hold', 'timeout'))] } })

    const response = await request(appWith(world)).post('/internal/suppliers/hold').send({
      supplier: 'SKY',
      supplierRatePlanId: 'r-1',
      checkIn: '2026-11-10',
      checkOut: '2026-11-12',
      guests: 2,
    })

    expect(response.status).toBe(504)
  })

  test('supplier tidak dapat dihubungi menjadi 503', async () => {
    const world = harness({
      script: { search: [err(failure('SKY', 'search', 'unavailable'))] },
    })

    const response = await request(appWith(world)).post('/internal/suppliers/search').send({
      supplier: 'SKY',
      city: 'Bali',
      checkIn: '2026-11-10',
      checkOut: '2026-11-12',
      guests: 2,
    })

    expect(response.status).toBe(503)
  })

  test('respons cacat menjadi 502 dan tidak membocorkan isinya', async () => {
    const world = harness({
      script: { priceCheck: [err(failure('SKY', 'priceCheck', 'invalid_response'))] },
    })

    const response = await request(appWith(world)).post('/internal/suppliers/price-check').send({
      supplier: 'SKY',
      supplierRatePlanId: 'r-1',
      checkIn: '2026-11-10',
      checkOut: '2026-11-12',
    })

    expect(response.status).toBe(502)
    expect(JSON.stringify(response.body)).not.toContain('bukan JSON')
  })
})

describe('pembatalan', () => {
  test('pembatalan yang berhasil dibalas tanpa isi pemesanan', async () => {
    const world = harness({ script: { cancel: [ok(undefined)] } })

    const response = await request(appWith(world))
      .post('/internal/suppliers/cancel')
      .send({ supplier: 'SKY', bookingReference: 'bkg_1' })

    expect(response.status).toBe(200)
    expect(response.body.data.status).toBe('cancelled')
  })
})

describe('konfigurasi supplier', () => {
  test('mendaftar seluruh supplier yang terkonfigurasi', async () => {
    const directory = memoryDirectory()
    await directory.update('SKY', { isActive: true })
    const world = harness({ directory })

    const response = await request(appWith(world)).get('/internal/suppliers')

    expect(response.status).toBe(200)
    expect(response.body.data).toHaveLength(1)
  })

  test('operator dapat menonaktifkan supplier', async () => {
    const world = harness({ directory: memoryDirectory() })

    const response = await request(appWith(world))
      .patch('/internal/suppliers/sky')
      .send({ isActive: false })

    expect(response.status).toBe(200)
    expect(response.body.data.isActive).toBe(false)
  })

  test('kode supplier yang tidak dikenal dibalas 404', async () => {
    const world = harness({ directory: memoryDirectory() })

    const response = await request(appWith(world))
      .patch('/internal/suppliers/mars')
      .send({ isActive: false })

    expect(response.status).toBe(404)
  })

  test('ambang pemutus dapat diubah saat berjalan', async () => {
    const world = harness({ directory: memoryDirectory() })

    const response = await request(appWith(world))
      .patch('/internal/suppliers/SKY')
      .send({ circuit: { failureThreshold: 9 } })

    expect(response.status).toBe(200)
    expect(response.body.data.circuit.failureThreshold).toBe(9)
  })
})

describe('kesehatan', () => {
  test('liveness tidak bergantung pada supplier sama sekali', async () => {
    const world = harness()

    const response = await request(appWith(world)).get('/health/live')

    expect(response.status).toBe(200)
  })

  test('kesiapan dilaporkan dari konfigurasi, bukan dari supplier yang sedang tumbang', async () => {
    // Service ini SIAP meski kelima supplier tumbang — justru itulah tugasnya.
    const directory = memoryDirectory()
    await directory.update('SKY', { isActive: true })
    const world = harness({
      directory,
      script: { search: [err(failure('SKY', 'search', 'unavailable'))] },
    })

    const response = await request(appWith(world)).get('/health/ready')

    expect(response.status).toBe(200)
    expect(response.body.data.status).toBe('ready')
  })
})
