import { Readable } from 'node:stream'
import { CORRELATION_HEADER } from '@tbe/shared-kernel'
import type { Request, Response } from 'express'
import request from 'supertest'
import { describe, expect, test, vi } from 'vitest'
import { USER_EMAIL_HEADER, USER_ID_HEADER } from '../domain/identity.js'
import {
  BUDI,
  VALID_TOKEN,
  createGatewayHarness,
  jsonResponse,
  tightLimiter,
} from '../testing/fakes.js'
import { createMethodGuard } from './method-guard.js'

const AUTH_HEADER = `Bearer ${VALID_TOKEN}`

describe('pemalsuan identitas', () => {
  test('membuang header identitas yang dikirim klien', async () => {
    // Inilah satu-satunya hal yang membuat kepercayaan service hulu terhadap
    // header identitas tidak menjadi celah eskalasi hak akses.
    const { app, upstream } = createGatewayHarness()

    await request(app)
      .get('/search?city=Bali')
      .set(USER_ID_HEADER, 'id-korban')
      .set(USER_EMAIL_HEADER, 'korban@example.com')

    const diteruskan = upstream.calls[0]?.headers ?? {}
    expect(diteruskan[USER_ID_HEADER]).toBeUndefined()
    expect(diteruskan[USER_EMAIL_HEADER]).toBeUndefined()
  })

  test('header palsu tidak menggantikan identitas hasil verifikasi', async () => {
    const { app, upstream } = createGatewayHarness()

    await request(app)
      .get('/bookings')
      .set('authorization', AUTH_HEADER)
      .set(USER_ID_HEADER, 'id-korban')

    expect(upstream.calls[0]?.headers[USER_ID_HEADER]).toBe(BUDI.userId)
  })

  test('membuang seluruh header berawalan internal, bukan hanya yang dipakai', async () => {
    const { app, upstream } = createGatewayHarness()

    await request(app).get('/search').set('x-tbe-peran', 'admin')

    expect(upstream.calls[0]?.headers['x-tbe-peran']).toBeUndefined()
  })
})

describe('autentikasi', () => {
  test('rute terlindungi menolak permintaan tanpa token', async () => {
    const { app, upstream } = createGatewayHarness()

    const response = await request(app).get('/bookings')

    expect(response.status).toBe(401)
    expect(upstream.calls).toHaveLength(0)
  })

  test('rute terlindungi menolak token yang tidak sah', async () => {
    const { app } = createGatewayHarness()

    const response = await request(app).get('/bookings').set('authorization', 'Bearer palsu')

    expect(response.status).toBe(401)
  })

  test('meneruskan identitas hasil verifikasi ke hulu', async () => {
    // Service hulu tidak perlu memverifikasi JWT lagi, dan karena itu tidak
    // perlu memegang rahasia penandatanganannya.
    const { app, upstream } = createGatewayHarness()

    await request(app).get('/bookings').set('authorization', AUTH_HEADER)

    expect(upstream.calls[0]?.headers[USER_ID_HEADER]).toBe(BUDI.userId)
    expect(upstream.calls[0]?.headers[USER_EMAIL_HEADER]).toBe(BUDI.email)
  })

  test('rute publik tetap dilayani tanpa token', async () => {
    const { app } = createGatewayHarness()

    expect((await request(app).get('/search?city=Bali')).status).toBe(200)
  })

  test('token tidak sah pada rute publik diabaikan, bukan ditolak', async () => {
    const { app, upstream } = createGatewayHarness()

    const response = await request(app).get('/search').set('authorization', 'Bearer palsu')

    expect(response.status).toBe(200)
    expect(upstream.calls[0]?.headers[USER_ID_HEADER]).toBeUndefined()
  })

  test('skema selain Bearer diperlakukan seperti tanpa token', async () => {
    const { app } = createGatewayHarness()

    expect((await request(app).get('/bookings').set('authorization', 'Basic abc')).status).toBe(401)
  })

  test('webhook pembayaran tidak membutuhkan token pengguna', async () => {
    // Keasliannya diverifikasi lewat tanda tangan di payment-service; gateway
    // tidak boleh memegang kunci penyedia.
    const { app } = createGatewayHarness()

    expect((await request(app).post('/payments/webhook').send({ order_id: 'x' })).status).toBe(200)
  })
})

describe('pembatasan laju', () => {
  test('menolak dengan 429 setelah kuota habis', async () => {
    const { app } = createGatewayHarness({ limiter: tightLimiter(2) })

    await request(app).get('/search')
    await request(app).get('/search')
    const ketiga = await request(app).get('/search')

    expect(ketiga.status).toBe(429)
  })

  test('mengirim header kuota pada setiap respons, bukan hanya saat ditolak', async () => {
    // Klien yang baik menyesuaikan kecepatannya sebelum kena batas, dan itu
    // hanya mungkin bila ia tahu sisa kuotanya.
    const { app } = createGatewayHarness({ limiter: tightLimiter(5) })

    const response = await request(app).get('/search')

    expect(response.headers['ratelimit-limit']).toBe('5')
    expect(response.headers['ratelimit-remaining']).toBe('4')
    expect(response.headers['ratelimit-reset']).toBeDefined()
  })

  test('menyertakan retry-after ketika menolak', async () => {
    const { app } = createGatewayHarness({ limiter: tightLimiter(1) })
    await request(app).get('/search')

    const ditolak = await request(app).get('/search')

    expect(ditolak.headers['retry-after']).toBeDefined()
  })

  test('kuota dihitung per pengguna, bukan per alamat IP bersama', async () => {
    // Memakai IP untuk pengguna yang sudah masuk akan menghukum seluruh kantor
    // yang berbagi satu alamat keluar.
    const { app } = createGatewayHarness({ limiter: tightLimiter(1) })

    await request(app).get('/bookings').set('authorization', AUTH_HEADER)
    const anonim = await request(app).get('/search')

    expect(anonim.status).toBe(200)
  })

  test('permintaan yang ditolak tidak pernah sampai ke hulu', async () => {
    const { app, upstream } = createGatewayHarness({ limiter: tightLimiter(1) })
    await request(app).get('/search')

    await request(app).get('/search')

    expect(upstream.calls).toHaveLength(1)
  })
})

describe('kegagalan hulu', () => {
  test('service yang tidak dapat dihubungi menghasilkan 503', async () => {
    const { app, upstream } = createGatewayHarness()
    upstream.respondWith({ kind: 'unreachable' })

    const response = await request(app).get('/search')

    expect(response.status).toBe(503)
  })

  test('tidak membocorkan nama host internal pada respons galat', async () => {
    const { app, upstream } = createGatewayHarness()
    upstream.respondWith({ kind: 'unreachable' })

    const response = await request(app).get('/search')

    const badan = JSON.stringify(response.body)
    expect(badan).not.toContain('localhost')
    expect(badan).not.toContain('search-service')
    expect(badan).not.toContain('4003')
  })

  test('batas waktu terlampaui menghasilkan 504', async () => {
    // Dibedakan dari 503 karena keduanya berarti hal berbeda bagi klien:
    // yang satu mungkin sudah dikerjakan hulu, yang satu pasti belum.
    const { app, upstream } = createGatewayHarness()
    upstream.respondWith({ kind: 'timeout' })

    expect((await request(app).get('/search')).status).toBe(504)
  })

  test('galat hulu tetap memakai amplop respons yang sama', async () => {
    const { app, upstream } = createGatewayHarness()
    upstream.respondWith({ kind: 'unreachable' })

    const response = await request(app).get('/search')

    expect(response.body.data).toBeNull()
    expect(response.body.error).toHaveProperty('correlationId')
  })
})

describe('penerusan', () => {
  test('meneruskan status dan badan respons hulu apa adanya', async () => {
    const { app, upstream } = createGatewayHarness()
    upstream.respondWith(jsonResponse(201, { data: { id: 'bkg_1' }, error: null }))

    const response = await request(app).post('/bookings').set('authorization', AUTH_HEADER).send({})

    expect(response.status).toBe(201)
    expect(response.body.data.id).toBe('bkg_1')
  })

  test('meneruskan path lengkap beserta query string', async () => {
    const { app, upstream } = createGatewayHarness()

    await request(app).get('/search?city=Bali&guests=2')

    expect(upstream.calls[0]?.request.path).toBe('/search?city=Bali&guests=2')
  })

  test('meneruskan correlationId ke hulu', async () => {
    const { app, upstream } = createGatewayHarness()

    await request(app).get('/search').set(CORRELATION_HEADER, 'req-dari-klien')

    expect(upstream.calls[0]?.headers[CORRELATION_HEADER]).toBe('req-dari-klien')
  })

  test('memakai batas waktu milik rutenya', async () => {
    const { app, upstream } = createGatewayHarness()

    await request(app).get('/search')
    await request(app).get('/bookings').set('authorization', AUTH_HEADER)

    expect(upstream.calls[0]?.request.timeoutMs).toBeLessThan(
      upstream.calls[1]?.request.timeoutMs ?? 0,
    )
  })

  test('rute streaming mematikan buffering perantara', async () => {
    // Tanpa ini, proksi di depan gateway menahan aliran sampai penuh dan SSE
    // berhenti bekerja tanpa satu pun galat.
    const { app, upstream } = createGatewayHarness()
    upstream.respondWith({
      kind: 'response',
      statusCode: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: Readable.from(['data: halo\n\n']),
    })

    const response = await request(app)
      .get('/bookings/stream/bkg_1')
      .set('authorization', AUTH_HEADER)

    expect(response.headers['x-accel-buffering']).toBe('no')
    expect(response.headers['cache-control']).toContain('no-cache')
  })

  test('rute tidak dikenal menghasilkan 404 tanpa menyentuh hulu', async () => {
    const { app, upstream } = createGatewayHarness()

    const response = await request(app).get('/tidak-ada')

    expect(response.status).toBe(404)
    expect(upstream.calls).toHaveLength(0)
  })

  test('tidak membocorkan header x-powered-by', async () => {
    const { app } = createGatewayHarness()

    expect((await request(app).get('/search')).headers['x-powered-by']).toBeUndefined()
  })
})

describe('penjaga metode', () => {
  test('meneruskan metode yang dipakai sistem ini', () => {
    const next = vi.fn()
    const res = { setHeader: vi.fn() } as unknown as Response

    createMethodGuard()({ method: 'POST' } as Request, res, next)

    expect(next).toHaveBeenCalledWith()
  })

  test('menolak TRACE dengan 405 dan header allow', () => {
    // TRACE memantulkan permintaan apa adanya, termasuk header, dan telah lama
    // menjadi jalan membaca cookie yang seharusnya tidak dapat dibaca skrip.
    const next = vi.fn()
    const setHeader = vi.fn()
    const res = { setHeader } as unknown as Response

    createMethodGuard()({ method: 'TRACE' } as Request, res, next)

    expect(setHeader).toHaveBeenCalledWith('allow', expect.stringContaining('GET'))
    expect(next.mock.calls[0]?.[0]).toMatchObject({ httpStatus: 405 })
  })
})

describe('kesehatan', () => {
  test('melaporkan siap ketika seluruh hulu terjangkau', async () => {
    const { app } = createGatewayHarness()

    const response = await request(app).get('/health/ready')

    expect(response.status).toBe(200)
    expect(response.body.data.status).toBe('ready')
  })

  test('melaporkan tidak siap ketika hulu tidak terjangkau', async () => {
    // Gateway yang menyatakan siap padahal hulunya mati akan menerima trafik
    // lalu menolak semuanya — dan dari luar itu terlihat seperti gateway yang
    // rusak, bukan hulu yang mati.
    const { app, upstream } = createGatewayHarness()
    upstream.setReachable(false)

    expect((await request(app).get('/health/ready')).status).toBe(503)
  })

  test('liveness tetap hidup meski hulu mati', async () => {
    const { app, upstream } = createGatewayHarness()
    upstream.setReachable(false)

    expect((await request(app).get('/health/live')).status).toBe(200)
  })

  test('health dan metrik tidak terkena pembatasan laju', async () => {
    // Orkestrator harus tetap dapat membaca keadaan justru ketika sistem
    // sedang membatasi laju.
    const { app } = createGatewayHarness({ limiter: tightLimiter(1) })
    await request(app).get('/search')

    expect((await request(app).get('/health/live')).status).toBe(200)
    expect((await request(app).get('/metrics')).status).toBe(200)
  })
})
