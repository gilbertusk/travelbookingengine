import { describe, expect, test } from 'vitest'
import { REDACTED, isSensitiveKey, redact, redactBody, redactHeaders } from './redaction.js'

/**
 * Redaksi payload.
 *
 * Tabel `supplier_requests` menyimpan badan permintaan apa adanya demi
 * penelusuran, dan badan permintaan ke supplier memuat kunci API. Kunci API
 * yang tersimpan di basis data berarti basis data yang bocor sekaligus
 * menjadi bocornya akses ke seluruh supplier.
 */

describe('pengenalan field sensitif', () => {
  test('mengenali berbagai ejaan kredensial', () => {
    for (const key of [
      'apiKey',
      'api_key',
      'API-KEY',
      'secret',
      'clientSecret',
      'password',
      'accessToken',
      'authorization',
      'credentialRef',
      'signature',
      'cardNumber',
      'cvv',
    ]) {
      expect(isSensitiveKey(key)).toBe(true)
    }
  })

  test('tidak meredaksi field yang justru dibutuhkan saat menelusuri', () => {
    for (const key of ['bookingId', 'holdRef', 'guestName', 'checkIn', 'supplierRatePlanId']) {
      expect(isSensitiveKey(key)).toBe(false)
    }
  })
})

describe('redaksi objek', () => {
  test('mengganti nilai sensitif dan membiarkan sisanya', () => {
    const result = redact({ holdRef: 'hld_1', apiKey: 'rahasia', guestName: 'Budi' })

    expect(result).toEqual({ holdRef: 'hld_1', apiKey: REDACTED, guestName: 'Budi' })
  })

  test('menelusuri objek bersarang', () => {
    const result = redact({ auth: { token: 'abc' }, stay: { checkIn: '2026-11-10' } })

    expect(result).toEqual({ auth: { token: REDACTED }, stay: { checkIn: '2026-11-10' } })
  })

  test('menelusuri larik', () => {
    const result = redact([{ password: 'a' }, { name: 'b' }])

    expect(result).toEqual([{ password: REDACTED }, { name: 'b' }])
  })

  test('tidak mengubah masukan', () => {
    // Meredaksi di tempat berarti payload yang sama — yang mungkin masih akan
    // dikirim ke supplier — ikut kehilangan kredensialnya.
    const input = { apiKey: 'rahasia' }
    redact(input)

    expect(input.apiKey).toBe('rahasia')
  })

  test('struktur yang sangat dalam dipotong, bukan menggantung', () => {
    let deep: unknown = { name: 'dasar' }
    for (let index = 0; index < 30; index += 1) deep = { nested: deep }

    expect(() => redact(deep)).not.toThrow()
  })

  test('nilai bukan objek dikembalikan apa adanya', () => {
    expect(redact('teks')).toBe('teks')
    expect(redact(42)).toBe(42)
    expect(redact(null)).toBeNull()
  })
})

describe('redaksi badan permintaan', () => {
  test('badan JSON diredaksi per field', () => {
    expect(redactBody('{"apiKey":"rahasia","city":"Bali"}')).toEqual({
      apiKey: REDACTED,
      city: 'Bali',
    })
  })

  test('badan kosong menjadi null', () => {
    expect(redactBody(undefined)).toBeNull()
    expect(redactBody('')).toBeNull()
  })

  test('badan XML yang memuat kredensial diredaksi seluruhnya', () => {
    // Yang tidak dapat diperiksa tidak dapat dijamin aman.
    expect(redactBody('<Envelope><ApiKey>rahasia</ApiKey></Envelope>')).toBe(REDACTED)
  })

  test('badan XML tanpa kredensial dibiarkan supaya tetap dapat ditelusuri', () => {
    const body = '<Envelope><Body><RateCode>r-1</RateCode></Body></Envelope>'

    expect(redactBody(body)).toBe(body)
  })
})

describe('redaksi header', () => {
  test('hanya header yang ada di daftar putih yang tercatat', () => {
    const result = redactHeaders({
      'content-type': 'application/json',
      authorization: 'Bearer rahasia',
      'x-api-key': 'rahasia',
      'retry-after': '30',
    })

    expect(result).toEqual({ 'content-type': 'application/json', 'retry-after': '30' })
  })

  test('daftar putih, bukan daftar hitam', () => {
    // Header baru yang ditambahkan supplier tidak boleh otomatis ikut
    // tercatat hanya karena namanya belum ada di daftar yang dilarang.
    expect(redactHeaders({ 'x-supplier-session': 'rahasia' })).toEqual({})
  })

  test('header bernilai larik digabung', () => {
    expect(redactHeaders({ accept: ['a', 'b'] })).toEqual({ accept: 'a, b' })
  })
})
