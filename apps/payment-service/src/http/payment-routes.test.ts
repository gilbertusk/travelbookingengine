import { describe, expect, test } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { createPaymentHttpApp } from '../composition/app.js'
import type { WebhookRateLimiter } from '../application/ports.js'
import {
  TEST_BOOKING_ID,
  TEST_PAYMENT_ID,
  givenPendingPayment,
  givenSucceededPayment,
  harness,
  rejectingVerifier,
  scriptedGateway,
  type Harness,
} from '../testing/fakes.js'

/**
 * Aplikasi dirangkai lewat factory YANG SAMA dengan produksi — hanya port-nya
 * yang dipalsukan. Aplikasi uji yang dirangkai sendiri akan berbeda dari yang
 * sesungguhnya, dan yang paling sering berbeda adalah urutan middleware.
 */
function app(world: Harness, limiter?: WebhookRateLimiter): Express {
  return createPaymentHttpApp({
    deps: world.deps,
    limiter: limiter ?? allowAll(),
    logger: world.deps.logger,
    serviceName: 'payment-service-test',
  }).app
}

function allowAll(): WebhookRateLimiter {
  return {
    async consume() {
      return await Promise.resolve({
        allowed: true,
        limit: 600,
        remaining: 599,
        resetAfterSeconds: 60,
      })
    },
  }
}

function denyAll(): WebhookRateLimiter {
  return {
    async consume() {
      return await Promise.resolve({
        allowed: false,
        limit: 600,
        remaining: 0,
        resetAfterSeconds: 42,
      })
    },
  }
}

const NOTIFICATION = {
  order_id: TEST_PAYMENT_ID,
  transaction_id: 'midtrans-tx-1',
  transaction_status: 'settlement',
  status_code: '200',
  gross_amount: '1250000.00',
  currency: 'IDR',
  signature_key: 'a'.repeat(128),
  payment_type: 'bank_transfer',
  merchant_id: 'M-1',
}

describe('POST /internal/payments', () => {
  test('membuat maksud pembayaran dan mengembalikan 201 beserta tautan penyedia', async () => {
    const world = harness()

    const response = await request(app(world))
      .post('/internal/payments')
      .send({
        bookingId: TEST_BOOKING_ID,
        idempotencyKey: 'bkg-1:attempt-1',
        amount: { amountMinor: 1_250_000, currency: 'IDR' },
      })

    expect(response.status).toBe(201)
    expect(response.body.data.payment.status).toBe('PENDING')
    expect(response.body.data.redirectUrl).toContain('http')
    // Pembayaran PENDING tidak punya rujukan penyedia, jadi tidak boleh ada
    // bidangnya di respons — union diskriminan domain yang menjaminnya.
    expect(response.body.data.payment.gatewayRef).toBeUndefined()
  })

  test('permintaan berulang mengembalikan 200, bukan pembayaran kedua', async () => {
    const world = harness()
    const body = {
      bookingId: TEST_BOOKING_ID,
      idempotencyKey: 'bkg-1:attempt-1',
      amount: { amountMinor: 1_250_000, currency: 'IDR' },
    }

    await request(app(world)).post('/internal/payments').send(body)
    const second = await request(app(world)).post('/internal/payments').send(body)

    expect(second.status).toBe(200)
    expect(world.payments.rows.size).toBe(1)
  })

  test('harga yang sudah berubah dijawab 409 dengan pesan untuk memuat ulang', async () => {
    const world = harness()

    const response = await request(app(world))
      .post('/internal/payments')
      .send({
        bookingId: TEST_BOOKING_ID,
        idempotencyKey: 'bkg-1:attempt-1',
        amount: { amountMinor: 900_000, currency: 'IDR' },
      })

    expect(response.status).toBe(409)
    expect(response.body.error.message).toContain('Harga sudah berubah')
  })

  test('badan permintaan tanpa nilai ditolak 400', async () => {
    const world = harness()

    const response = await request(app(world))
      .post('/internal/payments')
      .send({ bookingId: TEST_BOOKING_ID, idempotencyKey: 'k' })

    expect(response.status).toBe(400)
  })

  test('nilai uang berupa angka telanjang ditolak 400', async () => {
    const world = harness()

    const response = await request(app(world))
      .post('/internal/payments')
      .send({ bookingId: TEST_BOOKING_ID, idempotencyKey: 'k', amount: 1_250_000 })

    // Uang tanpa mata uangnya tidak dapat masuk ke sistem ini, bahkan lewat HTTP.
    expect(response.status).toBe(400)
  })

  test('nilai uang dengan pecahan ditolak 400', async () => {
    const world = harness()

    const response = await request(app(world))
      .post('/internal/payments')
      .send({
        bookingId: TEST_BOOKING_ID,
        idempotencyKey: 'k',
        amount: { amountMinor: 1_250_000.5, currency: 'IDR' },
      })

    expect(response.status).toBe(400)
  })
})

describe('GET /internal/payments/:id', () => {
  test('mengembalikan pembayaran beserta nilainya', async () => {
    const world = harness()
    await givenPendingPayment(world)

    const response = await request(app(world)).get(`/internal/payments/${TEST_PAYMENT_ID}`)

    expect(response.status).toBe(200)
    expect(response.body.data.payment.amount).toEqual({
      amountMinor: 1_250_000,
      currency: 'IDR',
    })
  })

  test('pembayaran yang tidak ada dijawab 404', async () => {
    const world = harness()

    const response = await request(app(world)).get(
      '/internal/payments/99999999-9999-4999-8999-999999999999',
    )

    expect(response.status).toBe(404)
  })

  test('pengenal yang bukan uuid dijawab 400', async () => {
    const world = harness()

    const response = await request(app(world)).get('/internal/payments/bukan-uuid')

    expect(response.status).toBe(400)
  })
})

describe('POST /webhooks/midtrans', () => {
  test('notifikasi yang sah dijawab 200 dan menerapkan perubahan', async () => {
    const world = harness()
    await givenPendingPayment(world)

    const response = await request(app(world)).post('/webhooks/midtrans').send(NOTIFICATION)

    expect(response.status).toBe(200)
    expect(response.body.data.outcome).toBe('applied')
    expect(world.payments.rows.get(TEST_PAYMENT_ID)?.status).toBe('SUCCEEDED')
  })

  test('notifikasi yang sama dua kali dijawab 200 dua kali dengan satu efek', async () => {
    const world = harness()
    await givenPendingPayment(world)

    await request(app(world)).post('/webhooks/midtrans').send(NOTIFICATION)
    const second = await request(app(world)).post('/webhooks/midtrans').send(NOTIFICATION)

    // 200, bukan galat: bagi penyedia, notifikasi itu sudah diterima. Menjawab
    // galat akan membuatnya mengirim ulang tanpa henti.
    expect(second.status).toBe(200)
    expect(second.body.data.outcome).toBe('duplicate')
    expect(world.events.published).toHaveLength(1)
  })

  test('tanda tangan tidak sah dijawab 401 tanpa menjelaskan sebabnya', async () => {
    const world = harness({ verifier: rejectingVerifier() })
    await givenPendingPayment(world)

    const response = await request(app(world)).post('/webhooks/midtrans').send(NOTIFICATION)

    expect(response.status).toBe(401)
    // Penyerang yang tahu tanda tangannya "hampir benar" mendapat informasi.
    expect(JSON.stringify(response.body)).not.toContain('signature')
  })

  test('notifikasi yang sedang diproses pihak lain dijawab 409 agar dikirim ulang', async () => {
    const world = harness()
    await givenPendingPayment(world)
    await world.ledger.claim({ providerEventId: 'midtrans-tx-1', payload: {} })

    const response = await request(app(world)).post('/webhooks/midtrans').send(NOTIFICATION)

    expect(response.status).toBe(409)
  })

  test('notifikasi untuk pembayaran tak dikenal dijawab 404', async () => {
    const world = harness()

    const response = await request(app(world)).post('/webhooks/midtrans').send(NOTIFICATION)

    expect(response.status).toBe(404)
  })

  test('notifikasi tanpa bidang wajib dijawab 400', async () => {
    const world = harness()

    const response = await request(app(world))
      .post('/webhooks/midtrans')
      .send({ order_id: TEST_PAYMENT_ID })

    expect(response.status).toBe(400)
  })

  test('bidang penyedia yang tidak dikenal tetap tercatat pada payload', async () => {
    const world = harness()
    await givenPendingPayment(world)

    await request(app(world))
      .post('/webhooks/midtrans')
      .send({ ...NOTIFICATION, bidang_baru_dari_penyedia: 'nilai' })

    const stored = world.ledger.rows.get('midtrans-tx-1')?.payload as Record<string, unknown>

    // Skema yang membuang bidang tak dikenal akan membuat catatan webhook
    // kehilangan justru bidang yang dicari ketika ada sengketa.
    expect(stored.bidang_baru_dari_penyedia).toBe('nilai')
    expect(stored.merchant_id).toBe('M-1')
  })

  test('pembatasan laju menolak dengan 429 dan menyebut kapan boleh mencoba lagi', async () => {
    const world = harness()
    await givenPendingPayment(world)

    const response = await request(app(world, denyAll()))
      .post('/webhooks/midtrans')
      .send(NOTIFICATION)

    expect(response.status).toBe(429)
    expect(response.headers['retry-after']).toBe('42')
    // Pembatas berjalan SEBELUM tanda tangan diverifikasi: satu SHA-512 per
    // notifikasi palsu adalah biaya yang tidak perlu dibayar.
    expect(world.ledger.rows.size).toBe(0)
  })

  test('endpoint webhook tidak memerlukan autentikasi pengguna', async () => {
    const world = harness()
    await givenPendingPayment(world)

    const response = await request(app(world))
      .post('/webhooks/midtrans')
      .set('authorization', '')
      .send(NOTIFICATION)

    // Yang menggantikan autentikasi adalah tanda tangan. Mewajibkan token di
    // sini berarti penyedia tidak dapat memanggilnya sama sekali.
    expect(response.status).toBe(200)
  })
})

describe('kesiapan', () => {
  test('health check menyentuh basis data', async () => {
    const world = harness()

    const response = await request(app(world)).get('/health/ready')

    expect(response.status).toBe(200)
    expect(JSON.stringify(response.body)).toContain('database')
  })
})

describe('jalur respons yang jarang tetapi nyata', () => {
  test('notifikasi berstatus refund dari penyedia dijawab 200 sebagai diabaikan', async () => {
    const world = harness()
    await givenPendingPayment(world)

    const response = await request(app(world))
      .post('/webhooks/midtrans')
      .send({ ...NOTIFICATION, transaction_status: 'refund' })

    expect(response.status).toBe(200)
    expect(response.body.data.outcome).toBe('ignored')
    expect(response.body.data.why).toBe('provider_refund_status')
  })

  test('nilai notifikasi yang tidak cocok dijawab 409 tanpa membocorkan angkanya', async () => {
    const world = harness()
    await givenPendingPayment(world)

    const response = await request(app(world))
      .post('/webhooks/midtrans')
      .send({ ...NOTIFICATION, gross_amount: '9250000.00' })

    expect(response.status).toBe(409)
    // Nilai yang kami harapkan tidak ikut ke respons. Ia ada di log bersama
    // correlationId — NFR-15.
    expect(JSON.stringify(response.body)).not.toContain('1250000')
  })

  test('penolakan penyedia saat pembuatan pembayaran dijawab 402', async () => {
    const world = harness({
      gateway: scriptedGateway({ charge: [{ kind: 'rejected', reason: 'kartu ditolak' }] }),
    })

    const response = await request(app(world))
      .post('/internal/payments')
      .send({
        bookingId: TEST_BOOKING_ID,
        idempotencyKey: 'bkg-1:attempt-1',
        amount: { amountMinor: 1_250_000, currency: 'IDR' },
      })

    expect(response.status).toBe(402)
    // Alasan dari penyedia TIDAK diteruskan: "kartu ditolak karena limit" adalah
    // informasi tentang pengguna yang tidak perlu melewati batas sistem kami.
    expect(JSON.stringify(response.body)).not.toContain('kartu ditolak')
  })

  test('penyedia yang tidak dapat dihubungi saat pembuatan pembayaran dijawab 502', async () => {
    const world = harness({ gateway: scriptedGateway({ charge: [{ kind: 'unavailable' }] }) })

    const response = await request(app(world))
      .post('/internal/payments')
      .send({
        bookingId: TEST_BOOKING_ID,
        idempotencyKey: 'bkg-1:attempt-1',
        amount: { amountMinor: 1_250_000, currency: 'IDR' },
      })

    expect(response.status).toBe(502)
  })

  test('pembayaran yang sudah direfund menampilkan daftar refundnya', async () => {
    const world = harness()
    const settled = await givenSucceededPayment(world)

    await world.payments.update({
      ...settled,
      status: 'PARTIALLY_REFUNDED',
      refunds: [
        {
          id: 'refund-1',
          requestId: '33333333-3333-4333-8333-333333333333',
          amount: { amountMinor: 250_000, currency: 'IDR' },
          reason: 'supplier_failed',
          status: 'SUCCEEDED',
          gatewayRef: 'midtrans-refund-1',
        },
      ],
    })

    const response = await request(app(world)).get(`/internal/payments/${TEST_PAYMENT_ID}`)

    expect(response.status).toBe(200)
    expect(response.body.data.payment.status).toBe('PARTIALLY_REFUNDED')
    expect(response.body.data.payment.refunds).toHaveLength(1)
    expect(response.body.data.payment.refunds[0].amount).toEqual({
      amountMinor: 250_000,
      currency: 'IDR',
    })
    // gatewayRef refund TIDAK ikut ke respons: ia rujukan internal ke penyedia,
    // dan klien tidak punya kegunaan untuknya.
    expect(response.body.data.payment.refunds[0].gatewayRef).toBeUndefined()
  })
})

describe('batas sistem', () => {
  test('pemesanan tanpa harga yang tercatat dijawab 409', async () => {
    const world = harness()
    world.payables.rows.clear()

    const response = await request(app(world))
      .post('/internal/payments')
      .send({
        bookingId: TEST_BOOKING_ID,
        idempotencyKey: 'bkg-1:attempt-1',
        amount: { amountMinor: 1_250_000, currency: 'IDR' },
      })

    expect(response.status).toBe(409)
    expect(response.body.error.message).toContain('belum siap dibayar')
  })

  /**
   * Galat tak terduga ditangkap di batas sistem dan tidak pernah membocorkan
   * detail internal — CONVENTIONS.md bagian 5 dan NFR-15. Yang paling mudah
   * bocor adalah pesan galat basis data, yang memuat nama tabel dan kadang nilai
   * kolom.
   */
  test('galat tak terduga dari basis data menjadi 500 tanpa membocorkan detailnya', async () => {
    const world = harness()
    const deps = {
      ...world.deps,
      payments: {
        ...world.payments,
        async findById(): Promise<never> {
          await Promise.resolve()

          throw new Error('relation "payments" does not exist')
        },
      },
    }

    const response = await request(
      createPaymentHttpApp({
        deps,
        limiter: allowAll(),
        logger: world.deps.logger,
        serviceName: 'payment-service-test',
      }).app,
    ).get(`/internal/payments/${TEST_PAYMENT_ID}`)

    expect(response.status).toBe(500)

    // Diperiksa pada TEKS yang bocor, bukan pada kata yang kebetulan terkandung.
    // Versi pertama uji ini menolak kata "relation" dan gagal karena respons
    // memuat `correlationId` — yang justru bidang yang membuat galat ini dapat
    // ditelusuri ke log-nya.
    const body = JSON.stringify(response.body)
    expect(body).not.toContain('does not exist')
    expect(body).not.toContain('relation "')
    expect(response.body.error.correlationId).toBeDefined()
  })
})
