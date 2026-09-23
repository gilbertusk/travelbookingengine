import { describe, expect, test } from 'vitest'
import {
  ConfigError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RateLimitedError,
  TimeoutError,
  UnauthorizedError,
  UpstreamError,
  ValidationError,
  isAppError,
} from './app-error.js'
import { GENERIC_SERVER_MESSAGE, toErrorResponse } from './error-response.js'

const CORRELATION_ID = '01927f3a-0000-7000-8000-000000000001'

describe('AppError', () => {
  test('menyetel name sesuai kelas turunannya, bukan Error', () => {
    expect(new ValidationError('salah').name).toBe('ValidationError')
    expect(new NotFoundError('tidak ada').name).toBe('NotFoundError')
  })

  test('bersifat operasional secara bawaan', () => {
    expect(new ValidationError('salah').isOperational).toBe(true)
  })

  test('mempertahankan cause agar rantai penyebab tidak putus di log', () => {
    const penyebab = new Error('koneksi ditolak')

    const error = new UpstreamError({ upstream: 'LUNA', message: 'gagal', cause: penyebab })

    expect(error.cause).toBe(penyebab)
  })

  test('UpstreamError membawa nama sistem hulu yang gagal', () => {
    expect(new UpstreamError({ upstream: 'ORBIT', message: 'gagal' }).upstream).toBe('ORBIT')
  })

  test('TimeoutError membawa batas waktu yang terlampaui', () => {
    const error = new TimeoutError({ message: 'lewat batas', timeoutMs: 1200, upstream: 'LUNA' })

    expect(error.timeoutMs).toBe(1200)
    expect(error.httpStatus).toBe(504)
  })

  test('ConfigError ditandai non-operasional karena menandakan cacat penyiapan', () => {
    expect(new ConfigError('env tidak sah').isOperational).toBe(false)
  })

  test('setiap kelas galat memetakan ke status HTTP yang benar', () => {
    // Pemetaan ini adalah kontrak antara domain dan batas HTTP. Diuji
    // menyeluruh karena satu status yang salah mengubah perilaku klien —
    // 409 dapat dicoba ulang, 400 tidak.
    expect(new ValidationError('x').httpStatus).toBe(400)
    expect(new UnauthorizedError().httpStatus).toBe(401)
    expect(new ForbiddenError().httpStatus).toBe(403)
    expect(new NotFoundError('x').httpStatus).toBe(404)
    expect(new ConflictError('x').httpStatus).toBe(409)
    expect(new RateLimitedError().httpStatus).toBe(429)
    expect(new ConfigError('x').httpStatus).toBe(500)
    expect(new UpstreamError({ upstream: 'a', message: 'x' }).httpStatus).toBe(502)
    expect(new TimeoutError({ message: 'x', timeoutMs: 1 }).httpStatus).toBe(504)
  })

  test('galat autentikasi punya pesan bawaan yang tidak menyebut sebabnya', () => {
    // Membedakan "email tidak terdaftar" dari "kata sandi salah" membocorkan
    // keberadaan akun. Pesan bawaan sengaja netral.
    expect(new UnauthorizedError().message).toBe('Autentikasi diperlukan')
    expect(new ForbiddenError().message).toBe('Akses ditolak')
    expect(new RateLimitedError().message).toBe('Terlalu banyak permintaan')
  })

  test('TimeoutError tanpa upstream tetap sah untuk batas waktu internal', () => {
    const error = new TimeoutError({ message: 'operasi lokal lewat batas', timeoutMs: 500 })

    expect(error.upstream).toBeUndefined()
    expect(error.timeoutMs).toBe(500)
  })

  test('isAppError membedakan error milik kita dari error biasa', () => {
    expect(isAppError(new ConflictError('bentrok'))).toBe(true)
    expect(isAppError(new Error('biasa'))).toBe(false)
    expect(isAppError('bukan error')).toBe(false)
    expect(isAppError(null)).toBe(false)
  })
})

describe('toErrorResponse', () => {
  test('meneruskan pesan dan detail untuk error operasional 4xx', () => {
    const error = new ValidationError('tanggal keluar harus setelah tanggal masuk', {
      field: 'checkOut',
    })

    const { status, body } = toErrorResponse(error, CORRELATION_ID)

    expect(status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.message).toBe('tanggal keluar harus setelah tanggal masuk')
    expect(body.error.details).toEqual({ field: 'checkOut' })
    expect(body.error.correlationId).toBe(CORRELATION_ID)
    expect(body.data).toBeNull()
  })

  test('menghilangkan kunci details ketika tidak ada', () => {
    const { body } = toErrorResponse(new NotFoundError('pemesanan tidak ditemukan'), CORRELATION_ID)

    expect(body.error).not.toHaveProperty('details')
  })

  test('menyembunyikan pesan asli untuk error 5xx milik kita sendiri', () => {
    // Arrange — pesan ini menyebut nama supplier, tidak boleh sampai ke klien
    const error = new UpstreamError({
      upstream: 'LUNA',
      message: 'LUNA membalas 503 dari 10.0.3.14:8080',
    })

    // Act
    const { status, body } = toErrorResponse(error, CORRELATION_ID)

    // Assert
    expect(status).toBe(502)
    expect(body.error.message).toBe(GENERIC_SERVER_MESSAGE)
    expect(JSON.stringify(body)).not.toContain('LUNA')
    expect(JSON.stringify(body)).not.toContain('10.0.3.14')
  })

  test('menyembunyikan detail untuk error non-operasional', () => {
    const error = new ConfigError('DATABASE_URL tidak diset', { variable: 'DATABASE_URL' })

    const { body } = toErrorResponse(error, CORRELATION_ID)

    expect(body.error.message).toBe(GENERIC_SERVER_MESSAGE)
    expect(body.error).not.toHaveProperty('details')
  })

  test('mengubah error tak dikenal menjadi 500 generik', () => {
    const { status, body } = toErrorResponse(
      new Error('ECONNREFUSED 127.0.0.1:5432'),
      CORRELATION_ID,
    )

    expect(status).toBe(500)
    expect(body.error.code).toBe('INTERNAL_ERROR')
    expect(body.error.message).toBe(GENERIC_SERVER_MESSAGE)
    expect(JSON.stringify(body)).not.toContain('5432')
  })

  test('mengubah nilai yang dilempar bukan Error menjadi 500 generik', () => {
    const { status, body } = toErrorResponse('string mentah', CORRELATION_ID)

    expect(status).toBe(500)
    expect(body.error.message).toBe(GENERIC_SERVER_MESSAGE)
  })

  test('selalu menyertakan correlationId agar galat dapat ditelusuri ke log', () => {
    expect(toErrorResponse(new Error('apa pun'), CORRELATION_ID).body.error.correlationId).toBe(
      CORRELATION_ID,
    )
  })
})
