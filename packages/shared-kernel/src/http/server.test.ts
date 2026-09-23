import type { Express } from 'express'
import request from 'supertest'
import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import { CORRELATION_HEADER } from '../correlation/correlation.js'
import { NotFoundError, UpstreamError, ValidationError } from '../errors/app-error.js'
import { GENERIC_SERVER_MESSAGE } from '../errors/error-response.js'
import { createLogger } from '../logger/logger.js'
import { isAcceptableCorrelationId } from './correlation-middleware.js'
import { success } from './envelope.js'
import { createHttpServer, finalizeHttpServer } from './server.js'
import { validate } from './validate.js'

const silentLogger = (): ReturnType<typeof createLogger> =>
  createLogger({
    serviceName: 'uji',
    level: 'silent',
    destination: {
      write(): void {
        // keluaran log tidak diuji di berkas ini
      },
    },
  })

const searchSchema = z.object({
  city: z.string().min(2),
  guests: z.coerce.number().int().positive().max(10),
})

const searchQuery = validate(searchSchema, 'query')
const bookingBody = validate(z.object({ ratePlanRef: z.string() }), 'body')
const tanpaPasang = validate(searchSchema, 'query')

function buildApp(): Express {
  const app = createHttpServer({ logger: silentLogger() })

  app.get('/ok', (_req, res) => {
    res.json(success({ pesan: 'baik' }))
  })

  app.get('/search', searchQuery, (_req, res) => {
    res.json(success(searchQuery.value(res)))
  })

  app.post('/bookings', bookingBody, (_req, res) => {
    res.status(201).json(success({ id: 'bk_1' }))
  })

  app.get('/not-found', () => {
    throw new NotFoundError('Pemesanan tidak ditemukan', { bookingId: 'bk_9' })
  })

  app.get('/upstream-down', () => {
    throw new UpstreamError({
      upstream: 'LUNA',
      message: 'LUNA membalas 503 dari 10.0.3.14:8080',
    })
  })

  app.get('/boom', () => {
    throw new Error('ECONNREFUSED 127.0.0.1:5432')
  })

  app.get('/tanpa-validate', (_req, res) => {
    res.json(success(tanpaPasang.value(res)))
  })

  return finalizeHttpServer(app, silentLogger())
}

describe('isAcceptableCorrelationId', () => {
  test('menerima bentuk yang wajar', () => {
    expect(isAcceptableCorrelationId('01927f3a-0000-7000-8000-000000000001')).toBe(true)
    expect(isAcceptableCorrelationId('req.123:abc-1')).toBe(true)
  })

  test('menolak nilai kosong, terlalu panjang, atau memuat karakter berbahaya', () => {
    expect(isAcceptableCorrelationId(undefined)).toBe(false)
    expect(isAcceptableCorrelationId('')).toBe(false)
    expect(isAcceptableCorrelationId('a'.repeat(129))).toBe(false)
    expect(isAcceptableCorrelationId('baris\nbaru')).toBe(false)
    expect(isAcceptableCorrelationId('{"json":"injeksi"}')).toBe(false)
  })
})

describe('server HTTP', () => {
  test('mengembalikan amplop sukses yang konsisten', async () => {
    const response = await request(buildApp()).get('/ok')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ data: { pesan: 'baik' }, error: null })
  })

  test('membuat correlationId dan mengembalikannya di header', async () => {
    const response = await request(buildApp()).get('/ok')

    expect(response.headers[CORRELATION_HEADER]).toMatch(/^[0-9a-f]{8}-/)
  })

  test('memakai correlationId dari klien ketika bentuknya dapat diterima', async () => {
    const response = await request(buildApp()).get('/ok').set(CORRELATION_HEADER, 'req-dari-klien')

    expect(response.headers[CORRELATION_HEADER]).toBe('req-dari-klien')
  })

  test('mengabaikan correlationId klien yang berbahaya dan menggantinya', async () => {
    // Arrange — nilai yang dapat merusak log terstruktur bila diteruskan apa adanya
    const jahat = 'x".injeksi'

    // Act
    const response = await request(buildApp()).get('/ok').set(CORRELATION_HEADER, jahat)

    // Assert
    expect(response.headers[CORRELATION_HEADER]).not.toBe(jahat)
    expect(response.headers[CORRELATION_HEADER]).toMatch(/^[0-9a-f]{8}-/)
  })

  test('tidak membocorkan header x-powered-by', async () => {
    const response = await request(buildApp()).get('/ok')

    expect(response.headers['x-powered-by']).toBeUndefined()
  })

  test('memasang header keamanan dari helmet', async () => {
    const response = await request(buildApp()).get('/ok')

    expect(response.headers['x-content-type-options']).toBe('nosniff')
  })
})

describe('validate', () => {
  test('meneruskan nilai terparse dan terkonversi', async () => {
    const response = await request(buildApp()).get('/search?city=Bali&guests=3')

    expect(response.status).toBe(200)
    expect(response.body.data).toEqual({ city: 'Bali', guests: 3 })
  })

  test('menolak query tidak sah dengan 400 dan menyebut field-nya', async () => {
    const response = await request(buildApp()).get('/search?city=B&guests=99')

    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('VALIDATION_ERROR')
    const fields = (response.body.error.details.issues as { field: string }[]).map((i) => i.field)
    expect(fields).toContain('city')
    expect(fields).toContain('guests')
  })

  test('menolak body tidak sah dengan 400', async () => {
    const response = await request(buildApp()).post('/bookings').send({ salah: 1 })

    expect(response.status).toBe(400)
    expect(response.body.error.details.source).toBe('body')
  })

  test('menerima body yang sah', async () => {
    const response = await request(buildApp()).post('/bookings').send({ ratePlanRef: 'rp_1' })

    expect(response.status).toBe(201)
  })

  test('pengakses value melempar bila middleware-nya tidak dipasang', async () => {
    const response = await request(buildApp()).get('/tanpa-validate')

    expect(response.status).toBe(500)
  })
})

describe('penanganan galat', () => {
  test('memetakan AppError 4xx ke status dan pesannya', async () => {
    const response = await request(buildApp()).get('/not-found')

    expect(response.status).toBe(404)
    expect(response.body.error.code).toBe('NOT_FOUND')
    expect(response.body.error.message).toBe('Pemesanan tidak ditemukan')
    expect(response.body.error.details).toEqual({ bookingId: 'bk_9' })
  })

  test('menyembunyikan detail internal pada galat hulu', async () => {
    const response = await request(buildApp()).get('/upstream-down')

    expect(response.status).toBe(502)
    expect(response.body.error.message).toBe(GENERIC_SERVER_MESSAGE)
    expect(JSON.stringify(response.body)).not.toContain('LUNA')
  })

  test('menyembunyikan detail internal pada galat tak terduga', async () => {
    const response = await request(buildApp()).get('/boom')

    expect(response.status).toBe(500)
    expect(response.body.error.code).toBe('INTERNAL_ERROR')
    expect(JSON.stringify(response.body)).not.toContain('5432')
  })

  test('menyertakan correlationId pada setiap respons galat', async () => {
    const response = await request(buildApp()).get('/boom').set(CORRELATION_HEADER, 'req-galat')

    expect(response.body.error.correlationId).toBe('req-galat')
  })

  test('mengembalikan 404 dengan amplop yang sama untuk rute tidak dikenal', async () => {
    const response = await request(buildApp()).get('/rute-yang-tidak-ada')

    expect(response.status).toBe(404)
    expect(response.body.data).toBeNull()
    expect(response.body.error.code).toBe('NOT_FOUND')
  })

  test('ValidationError yang dilempar langsung tetap menghasilkan 400', async () => {
    const app = createHttpServer({ logger: silentLogger() })
    app.get('/manual', () => {
      throw new ValidationError('tanggal keluar harus setelah tanggal masuk')
    })
    finalizeHttpServer(app, silentLogger())

    const response = await request(app).get('/manual')

    expect(response.status).toBe(400)
    expect(response.body.error.message).toBe('tanggal keluar harus setelah tanggal masuk')
  })
})
