import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { getAccessToken, setAccessToken } from '@/lib/access-token'
import { ApiError } from '@/lib/api-error'
import { login, logout, register } from './api'

/**
 * Panggilan jaringan fitur autentikasi.
 *
 * Yang diperiksa terutama satu hal: masuk dan daftar TIDAK boleh memanggil
 * gateway langsung. Keduanya harus lewat rute Next, karena hanya di sana
 * refresh token dapat masuk ke cookie httpOnly tanpa pernah tersentuh
 * JavaScript halaman.
 */

const fetchMock = vi.fn<typeof fetch>()

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  setAccessToken(undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const BUDI = {
  id: 'u1',
  email: 'budi@example.com',
  name: 'Budi',
  createdAt: '2026-01-01T00:00:00Z',
}

describe('masuk', () => {
  test('memanggil rute Next, bukan gateway langsung', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ user: BUDI, accessToken: 'token-abc' }))

    await login({ email: 'budi@example.com', password: 'kataSandiPanjang' })

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/auth/login')
  })

  test('menyimpan access token ke memori', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ user: BUDI, accessToken: 'token-abc' }))

    const session = await login({ email: 'budi@example.com', password: 'kataSandiPanjang' })

    expect(session.user).toEqual(BUDI)
    expect(getAccessToken()).toBe('token-abc')
  })

  test('kredensial salah menjadi galat yang dapat ditampilkan', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { error: { code: 'UNAUTHORIZED', message: 'Surel atau kata sandi salah' } },
        401,
      ),
    )

    await expect(login({ email: 'budi@example.com', password: 'salah' })).rejects.toMatchObject({
      kind: 'unauthorized',
      code: 'UNAUTHORIZED',
    })

    expect(getAccessToken()).toBeUndefined()
  })

  test('respons tanpa token dianggap gagal meski statusnya 200', async () => {
    // Menerima sesi tanpa token berarti aplikasi mengira pengguna sudah masuk
    // lalu gagal pada setiap permintaan berikutnya, tanpa jalan keluar.
    fetchMock.mockResolvedValue(jsonResponse({ user: BUDI }))

    await expect(login({ email: 'budi@example.com', password: 'x' })).rejects.toBeInstanceOf(
      ApiError,
    )
  })
})

describe('daftar', () => {
  test('memanggil rute Next dan menyimpan tokennya', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ user: BUDI, accessToken: 'token-baru' }, 201))

    await register({ name: 'Budi', email: 'budi@example.com', password: 'kataSandiPanjang' })

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/auth/register')
    expect(getAccessToken()).toBe('token-baru')
  })
})

describe('keluar', () => {
  test('membuang token dari memori', async () => {
    setAccessToken('token-abc')
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }))

    await logout()

    expect(getAccessToken()).toBeUndefined()
  })

  test('tetap membuang token meski permintaannya gagal', async () => {
    // Keluar yang gagal di server tetapi menyisakan token di peramban adalah
    // keadaan terburuk: pengguna yakin sudah keluar, padahal belum.
    setAccessToken('token-abc')
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

    await expect(logout()).rejects.toBeInstanceOf(TypeError)
    expect(getAccessToken()).toBeUndefined()
  })
})
