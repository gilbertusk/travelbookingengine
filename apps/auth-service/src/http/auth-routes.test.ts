import request from 'supertest'
import { describe, expect, test } from 'vitest'
import type { LoginAttemptLimiter } from '../application/ports.js'
import { createAuthHarness, type AuthHarness } from '../testing/fakes.js'

const EMAIL = 'budi@example.com'
const PASSWORD = 'kataSandiPanjangAman'
const REGISTER_BODY = { email: EMAIL, password: PASSWORD, name: 'Budi' }

async function daftar(harness: AuthHarness) {
  const response = await request(harness.app).post('/auth/register').send(REGISTER_BODY)
  expect(response.status).toBe(201)
  return response.body.data as {
    user: { id: string; email: string; name: string }
    accessToken: string
    refreshToken: string
  }
}

describe('POST /auth/register', () => {
  test('membuat akun dan mengembalikan pengguna beserta token', async () => {
    const harness = createAuthHarness()

    const data = await daftar(harness)

    expect(data.user.email).toBe(EMAIL)
    expect(data.accessToken).toBeDefined()
    expect(data.refreshToken).toBeDefined()
  })

  test('tidak pernah mengembalikan hash kata sandi', async () => {
    const harness = createAuthHarness()

    const response = await request(harness.app).post('/auth/register').send(REGISTER_BODY)

    expect(JSON.stringify(response.body)).not.toContain('fake$')
    expect(JSON.stringify(response.body)).not.toContain(PASSWORD)
  })

  test('menolak kata sandi pendek dengan 400', async () => {
    const harness = createAuthHarness()

    const response = await request(harness.app)
      .post('/auth/register')
      .send({ ...REGISTER_BODY, password: 'pendek' })

    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('VALIDATION_ERROR')
  })

  test('menolak surel yang sudah terdaftar dengan 409', async () => {
    const harness = createAuthHarness()
    await daftar(harness)

    const response = await request(harness.app).post('/auth/register').send(REGISTER_BODY)

    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('CONFLICT')
  })

  test('menolak badan permintaan yang tidak lengkap', async () => {
    const harness = createAuthHarness()

    expect((await request(harness.app).post('/auth/register').send({ email: EMAIL })).status).toBe(
      400,
    )
  })
})

describe('POST /auth/login', () => {
  test('mengembalikan token untuk kredensial yang benar', async () => {
    const harness = createAuthHarness()
    await daftar(harness)

    const response = await request(harness.app)
      .post('/auth/login')
      .send({ email: EMAIL, password: PASSWORD })

    expect(response.status).toBe(200)
    expect(response.body.data.tokenType).toBe('Bearer')
  })

  test('kata sandi salah dan surel tak terdaftar menghasilkan respons identik', async () => {
    const harness = createAuthHarness()
    await daftar(harness)

    const salahSandi = await request(harness.app)
      .post('/auth/login')
      .send({ email: EMAIL, password: 'salahSekali123' })
    const tidakAda = await request(harness.app)
      .post('/auth/login')
      .send({ email: 'lain@example.com', password: PASSWORD })

    expect(salahSandi.status).toBe(401)
    expect(tidakAda.status).toBe(401)
    expect(salahSandi.body.error.message).toBe(tidakAda.body.error.message)
    expect(salahSandi.body.error.code).toBe(tidakAda.body.error.code)
  })

  test('pesan galat tidak menyebutkan keberadaan akun', async () => {
    const harness = createAuthHarness()

    const response = await request(harness.app)
      .post('/auth/login')
      .send({ email: EMAIL, password: PASSWORD })

    expect(response.body.error.message.toLowerCase()).not.toContain('tidak terdaftar')
    expect(response.body.error.message.toLowerCase()).not.toContain('tidak ditemukan')
  })

  test('menjawab 429 ketika percobaan dibatasi', async () => {
    const blokir: LoginAttemptLimiter = {
      isBlocked: async () => Promise.resolve(true),
      recordFailure: async () => Promise.resolve(),
      reset: async () => Promise.resolve(),
    }
    const harness = createAuthHarness({ limiter: blokir })

    const response = await request(harness.app)
      .post('/auth/login')
      .send({ email: EMAIL, password: PASSWORD })

    expect(response.status).toBe(429)
  })
})

describe('POST /auth/refresh', () => {
  test('menukar refresh token dengan yang baru', async () => {
    const harness = createAuthHarness()
    const { refreshToken } = await daftar(harness)

    const response = await request(harness.app).post('/auth/refresh').send({ refreshToken })

    expect(response.status).toBe(200)
    expect(response.body.data.refreshToken).not.toBe(refreshToken)
  })

  test('menolak token yang sudah dipakai dengan 401', async () => {
    const harness = createAuthHarness()
    const { refreshToken } = await daftar(harness)
    await request(harness.app).post('/auth/refresh').send({ refreshToken })

    const response = await request(harness.app).post('/auth/refresh').send({ refreshToken })

    expect(response.status).toBe(401)
  })

  test('tidak membocorkan alasan penolakan kepada klien', async () => {
    // Membedakan "kedaluwarsa" dari "dipakai ulang" memberi tahu penyerang
    // apakah tokennya pernah sah.
    const harness = createAuthHarness()
    const { refreshToken } = await daftar(harness)
    await request(harness.app).post('/auth/refresh').send({ refreshToken })

    const dipakaiUlang = await request(harness.app).post('/auth/refresh').send({ refreshToken })
    const tidakDikenal = await request(harness.app)
      .post('/auth/refresh')
      .send({ refreshToken: 'bukan-token' })

    expect(dipakaiUlang.body.error.message).toBe(tidakDikenal.body.error.message)
  })
})

describe('POST /auth/logout', () => {
  test('mencabut sesi sehingga refresh berikutnya gagal', async () => {
    const harness = createAuthHarness()
    const { refreshToken } = await daftar(harness)

    const keluar = await request(harness.app).post('/auth/logout').send({ refreshToken })

    expect(keluar.status).toBe(200)
    expect((await request(harness.app).post('/auth/refresh').send({ refreshToken })).status).toBe(
      401,
    )
  })

  test('token tidak dikenal tetap dijawab 200', async () => {
    const harness = createAuthHarness()

    const response = await request(harness.app)
      .post('/auth/logout')
      .send({ refreshToken: 'bukan-token' })

    expect(response.status).toBe(200)
  })
})

describe('GET dan PATCH /auth/me', () => {
  test('mengembalikan profil dengan access token yang sah', async () => {
    const harness = createAuthHarness()
    const { accessToken, user } = await daftar(harness)

    const response = await request(harness.app)
      .get('/auth/me')
      .set('authorization', `Bearer ${accessToken}`)

    expect(response.status).toBe(200)
    expect(response.body.data.id).toBe(user.id)
    expect(response.body.data).not.toHaveProperty('passwordHash')
  })

  test('menolak tanpa header authorization', async () => {
    const harness = createAuthHarness()

    expect((await request(harness.app).get('/auth/me')).status).toBe(401)
  })

  test('menolak skema selain Bearer', async () => {
    const harness = createAuthHarness()
    const { accessToken } = await daftar(harness)

    const response = await request(harness.app)
      .get('/auth/me')
      .set('authorization', `Basic ${accessToken}`)

    expect(response.status).toBe(401)
  })

  test('menolak token yang tidak sah', async () => {
    const harness = createAuthHarness()

    const response = await request(harness.app)
      .get('/auth/me')
      .set('authorization', 'Bearer token.palsu')

    expect(response.status).toBe(401)
  })

  test('memperbarui nama', async () => {
    const harness = createAuthHarness()
    const { accessToken } = await daftar(harness)

    const response = await request(harness.app)
      .patch('/auth/me')
      .set('authorization', `Bearer ${accessToken}`)
      .send({ name: '  Budi Santoso  ' })

    expect(response.status).toBe(200)
    expect(response.body.data.name).toBe('Budi Santoso')
  })

  test('menolak pembaruan tanpa autentikasi', async () => {
    const harness = createAuthHarness()

    expect((await request(harness.app).patch('/auth/me').send({ name: 'X' })).status).toBe(401)
  })
})

describe('kebersihan respons', () => {
  test('seluruh respons memakai amplop yang sama', async () => {
    const harness = createAuthHarness()
    const berhasil = await request(harness.app).post('/auth/register').send(REGISTER_BODY)
    const gagal = await request(harness.app).post('/auth/register').send(REGISTER_BODY)

    expect(berhasil.body).toHaveProperty('data')
    expect(berhasil.body.error).toBeNull()
    expect(gagal.body.data).toBeNull()
    expect(gagal.body.error).toHaveProperty('correlationId')
  })

  test('menyediakan endpoint metrik', async () => {
    const harness = createAuthHarness()

    const response = await request(harness.app).get('/metrics')

    expect(response.status).toBe(200)
    expect(response.text).toContain('http_request_duration_seconds')
  })
})
