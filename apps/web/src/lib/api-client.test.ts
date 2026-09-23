import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { getAccessToken, setAccessToken } from './access-token'
import { apiRequest } from './api-client'
import { ApiError } from './api-error'

/**
 * Lapisan akses data.
 *
 * Yang diuji di sini adalah empat hal yang selalu salah kalau ditulis ulang di
 * banyak tempat: penyisipan token, penanganan 401, penerjemahan kegagalan, dan
 * pembacaan respons yang bukan JSON.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  setAccessToken(undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function requestInit(call: number): RequestInit {
  return fetchMock.mock.calls[call]?.[1] ?? {}
}

function headersOf(call: number): Record<string, string> {
  return (requestInit(call).headers ?? {}) as Record<string, string>
}

describe('penyisipan token', () => {
  test('mengirim access token sebagai bearer saat tersedia', async () => {
    setAccessToken('token-abc')
    fetchMock.mockResolvedValue(jsonResponse({ data: { id: 'u1' }, error: null }))

    await apiRequest('/auth/me')

    expect(headersOf(0).authorization).toBe('Bearer token-abc')
  })

  test('tidak mengirim header authorization saat belum ada sesi', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { hasil: [] }, error: null }))

    await apiRequest('/search?kota=Bali')

    expect(headersOf(0).authorization).toBeUndefined()
  })

  test('hanya menyetel content-type saat ada badan permintaan', async () => {
    // Dibuat baru pada setiap panggilan: badan Response hanya dapat dibaca
    // sekali, jadi satu objek yang dipakai ulang akan gagal di panggilan kedua.
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse({ data: { ok: true }, error: null })),
    )

    await apiRequest('/bookings', { method: 'GET' })
    await apiRequest('/bookings', { method: 'POST', body: { kamar: 2 } })

    expect(headersOf(0)['content-type']).toBeUndefined()
    expect(headersOf(1)['content-type']).toBe('application/json')
    expect(requestInit(1).body).toBe('{"kamar":2}')
  })
})

describe('penanganan 401', () => {
  test('menyegarkan token sekali lalu mengulang permintaan', async () => {
    setAccessToken('token-lama')

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: null, error: { code: 'UNAUTHORIZED' } }, 401))
      .mockResolvedValueOnce(jsonResponse({ accessToken: 'token-baru' }))
      .mockResolvedValueOnce(jsonResponse({ data: { id: 'u1' }, error: null }))

    await expect(apiRequest('/auth/me')).resolves.toEqual({ id: 'u1' })

    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/auth/refresh')
    expect(getAccessToken()).toBe('token-baru')
    // Permintaan ulang memakai token yang baru, bukan yang sudah ditolak.
    expect(headersOf(2).authorization).toBe('Bearer token-baru')
  })

  test('tidak menyegarkan dua kali ketika permintaan ulang juga ditolak', async () => {
    // Refresh berantai adalah cara membuat satu sesi mati menghasilkan
    // permintaan tanpa henti, sementara pengguna menatap layar memuat.
    setAccessToken('token-lama')

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: null, error: null }, 401))
      .mockResolvedValueOnce(jsonResponse({ accessToken: 'token-baru' }))
      .mockResolvedValueOnce(jsonResponse({ data: null, error: null }, 401))

    await expect(apiRequest('/auth/me')).rejects.toBeInstanceOf(ApiError)

    const refreshCalls = fetchMock.mock.calls.filter((call) => call[0] === '/api/auth/refresh')
    expect(refreshCalls.length).toBe(1)
  })

  test('membuang token dan melaporkan sesi berakhir saat refresh gagal', async () => {
    setAccessToken('token-lama')

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: null, error: null }, 401))
      .mockResolvedValueOnce(jsonResponse({ error: { code: 'SESSION_EXPIRED' } }, 401))

    await expect(apiRequest('/auth/me')).rejects.toMatchObject({
      kind: 'unauthorized',
      code: 'SESSION_EXPIRED',
    })

    expect(getAccessToken()).toBeUndefined()
  })

  test('refresh yang membalas tanpa token dianggap gagal', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: null, error: null }, 401))
      .mockResolvedValueOnce(jsonResponse({ accessToken: 12_345 }))

    await expect(apiRequest('/auth/me')).rejects.toMatchObject({ code: 'SESSION_EXPIRED' })
    expect(getAccessToken()).toBeUndefined()
  })
})

describe('penerjemahan kegagalan', () => {
  test('kegagalan jaringan menjadi galat berjenis network', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

    await expect(apiRequest('/search')).rejects.toMatchObject({
      kind: 'network',
      code: 'NETWORK_ERROR',
    })
  })

  test('status memetakan jenis galat yang berbeda', async () => {
    const cases = [
      { status: 429, kind: 'rate_limited' },
      { status: 400, kind: 'client' },
      { status: 503, kind: 'server' },
    ] as const

    for (const { status, kind } of cases) {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ data: null, error: { code: 'X', message: 'pesan' } }, status),
      )

      await expect(apiRequest('/search')).rejects.toMatchObject({ kind, status })
    }
  })

  test('respons yang bukan JSON tidak menggantikan status aslinya', async () => {
    // Halaman galat proksi berbentuk HTML akan membuat response.json() melempar.
    // Kalau galat penguraian itu dibiarkan naik, yang sampai ke pengguna adalah
    // "Unexpected token <", bukan keterangan bahwa layanan sedang bermasalah.
    fetchMock.mockResolvedValue(new Response('<html>502 Bad Gateway</html>', { status: 502 }))

    await expect(apiRequest('/search')).rejects.toMatchObject({ kind: 'server', status: 502 })
  })

  test('respons berhasil tanpa data dianggap tidak sesuai bentuk', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: null, error: null }))

    await expect(apiRequest('/search')).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  test('membuka amplop dan mengembalikan isinya saja', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { total: 3 }, error: null }))

    await expect(apiRequest('/search')).resolves.toEqual({ total: 3 })
  })
})
