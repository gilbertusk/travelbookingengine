import { describe, expect, test } from 'vitest'
import { asPasswordHash, asRawPassword } from '../domain/password.js'
import { ARGON2_OPTIONS, createArgon2Hasher } from './argon2-hasher.js'
import { createJoseTokenIssuer } from './jose-token-issuer.js'
import {
  constantTimeEquals,
  createMemoryLoginLimiter,
  createRefreshTokenFactory,
  uuidFactory,
} from './runtime.js'

/**
 * Adapter sungguhan — Argon2 dan JWT — diuji terpisah dari use case.
 *
 * Use case memakai tiruan agar cepat; yang di sini memakai pustaka aslinya,
 * karena justru parameter dan opsinya yang menentukan apakah implementasinya
 * aman. Jumlah test-nya sedikit dan sengaja begitu: Argon2 lambat.
 */

const SECRET = 'rahasia-uji-yang-cukup-panjang-32-karakter'
const ISSUER_OPTIONS = {
  secret: SECRET,
  issuer: 'tbe-auth',
  audience: 'tbe-api',
  accessTokenTtlSeconds: 900,
}

describe('Argon2', () => {
  test('memakai argon2id dengan parameter profil OWASP', () => {
    // Menurunkan parameter "supaya lebih cepat" membatalkan seluruh manfaatnya.
    expect(ARGON2_OPTIONS.memoryCost).toBeGreaterThanOrEqual(19_456)
    expect(ARGON2_OPTIONS.timeCost).toBeGreaterThanOrEqual(2)
  })

  test('menghasilkan hash argon2id dan memverifikasinya', async () => {
    const hasher = createArgon2Hasher()
    const raw = asRawPassword('kataSandiPanjangAman')

    const hash = await hasher.hash(raw)

    expect(hash).toMatch(/^\$argon2id\$/)
    expect(await hasher.verify(hash, raw)).toBe(true)
  })

  test('hash dua kali atas kata sandi sama menghasilkan nilai berbeda', async () => {
    // Salt acak. Hash yang sama untuk kata sandi yang sama berarti tabel
    // pelangi dapat dipakai lagi.
    const hasher = createArgon2Hasher()
    const raw = asRawPassword('kataSandiPanjangAman')

    expect(await hasher.hash(raw)).not.toBe(await hasher.hash(raw))
  })

  test('menolak kata sandi salah', async () => {
    const hasher = createArgon2Hasher()
    const hash = await hasher.hash(asRawPassword('kataSandiPanjangAman'))

    expect(await hasher.verify(hash, asRawPassword('kataSandiLainnyaAman'))).toBe(false)
  })

  test('hash yang rusak dijawab false, bukan melempar', async () => {
    // Melemparnya membuat endpoint masuk menjawab 500, dan sekaligus
    // membocorkan bahwa akunnya memang ada.
    const hasher = createArgon2Hasher()

    expect(await hasher.verify(asPasswordHash('bukan-hash'), asRawPassword('apa pun'))).toBe(false)
  })
})

describe('penerbit token JWT', () => {
  test('menerbitkan token yang dapat diverifikasi kembali', async () => {
    const issuer = createJoseTokenIssuer(ISSUER_OPTIONS)

    const token = await issuer.issueAccessToken({ sub: 'user-1', email: 'budi@example.com' })

    expect(await issuer.verifyAccessToken(token)).toEqual({
      sub: 'user-1',
      email: 'budi@example.com',
    })
  })

  test('menolak token dari rahasia yang berbeda', async () => {
    const asli = createJoseTokenIssuer(ISSUER_OPTIONS)
    const penyerang = createJoseTokenIssuer({ ...ISSUER_OPTIONS, secret: `${SECRET}-lain` })

    const token = await penyerang.issueAccessToken({ sub: 'user-1', email: 'x@example.com' })

    expect(await asli.verifyAccessToken(token)).toBeUndefined()
  })

  test('menolak token untuk audience lain', async () => {
    const asli = createJoseTokenIssuer(ISSUER_OPTIONS)
    const lain = createJoseTokenIssuer({ ...ISSUER_OPTIONS, audience: 'layanan-lain' })

    const token = await lain.issueAccessToken({ sub: 'user-1', email: 'x@example.com' })

    expect(await asli.verifyAccessToken(token)).toBeUndefined()
  })

  test('menolak token dengan algoritma alg none', async () => {
    // Celah klasik: pustaka yang mempercayai header token itu sendiri akan
    // menerima token tanpa tanda tangan sama sekali.
    const issuer = createJoseTokenIssuer(ISSUER_OPTIONS)
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(
      JSON.stringify({ sub: 'user-1', email: 'x@example.com', aud: 'tbe-api', iss: 'tbe-auth' }),
    ).toString('base64url')

    expect(await issuer.verifyAccessToken(`${header}.${payload}.`)).toBeUndefined()
  })

  test('menolak token yang bentuknya rusak', async () => {
    const issuer = createJoseTokenIssuer(ISSUER_OPTIONS)

    expect(await issuer.verifyAccessToken('bukan.sebuah.jwt')).toBeUndefined()
    expect(await issuer.verifyAccessToken('')).toBeUndefined()
  })
})

describe('refresh token', () => {
  test('menghasilkan token acak yang berbeda setiap kali', () => {
    const factory = createRefreshTokenFactory(1_000)

    expect(factory.create().token).not.toBe(factory.create().token)
  })

  test('hash bersifat deterministik dan bukan tokennya sendiri', () => {
    // Basis data yang bocor tidak boleh langsung memberi penyerang sesi hidup.
    const factory = createRefreshTokenFactory(1_000)
    const { token, hash } = factory.create()

    expect(factory.hash(token)).toBe(hash)
    expect(hash).not.toBe(token)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('utilitas', () => {
  test('uuid v7 terurut menurut waktu', async () => {
    const pertama = uuidFactory.newId()
    await new Promise((resolve) => setTimeout(resolve, 2))
    const kedua = uuidFactory.newId()

    expect(pertama).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/)
    expect(kedua > pertama).toBe(true)
  })

  test('perbandingan waktu tetap membedakan nilai dengan benar', () => {
    expect(constantTimeEquals('abc', 'abc')).toBe(true)
    expect(constantTimeEquals('abc', 'abd')).toBe(false)
    expect(constantTimeEquals('abc', 'abcd')).toBe(false)
  })

  test('pembatas memblokir setelah ambang tercapai', async () => {
    const limiter = createMemoryLoginLimiter({ maxFailures: 3, windowMs: 60_000 })

    expect(await limiter.isBlocked('budi')).toBe(false)
    await limiter.recordFailure('budi')
    await limiter.recordFailure('budi')
    expect(await limiter.isBlocked('budi')).toBe(false)
    await limiter.recordFailure('budi')

    expect(await limiter.isBlocked('budi')).toBe(true)
  })

  test('pembatas mengosongkan hitungan setelah berhasil masuk', async () => {
    const limiter = createMemoryLoginLimiter({ maxFailures: 1, windowMs: 60_000 })
    await limiter.recordFailure('budi')

    await limiter.reset('budi')

    expect(await limiter.isBlocked('budi')).toBe(false)
  })

  test('pembatas tidak mencampur akun yang berbeda', async () => {
    const limiter = createMemoryLoginLimiter({ maxFailures: 1, windowMs: 60_000 })

    await limiter.recordFailure('budi')

    expect(await limiter.isBlocked('budi')).toBe(true)
    expect(await limiter.isBlocked('siti')).toBe(false)
  })

  test('hitungan kedaluwarsa setelah jendela waktu lewat', async () => {
    const limiter = createMemoryLoginLimiter({ maxFailures: 1, windowMs: 10 })
    await limiter.recordFailure('budi')

    await new Promise((resolve) => setTimeout(resolve, 25))

    expect(await limiter.isBlocked('budi')).toBe(false)
  })
})
