import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { callGateway, gatewayErrorResponse } from './gateway'

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
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('pemanggilan gateway dari server', () => {
  test('membuka amplop respons berhasil', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { accessToken: 'abc' }, error: null }))

    await expect(callGateway('/auth/login', { method: 'POST', body: {} })).resolves.toMatchObject({
      ok: true,
      data: { accessToken: 'abc' },
    })
  })

  test('meneruskan status dan kode galat apa adanya', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ data: null, error: { code: 'UNAUTHORIZED', message: 'ditolak' } }, 401),
    )

    await expect(callGateway('/auth/login', { method: 'POST', body: {} })).resolves.toMatchObject({
      ok: false,
      status: 401,
      error: { code: 'UNAUTHORIZED' },
    })
  })

  test('gateway yang tidak dapat dihubungi menjadi 503 tanpa membocorkan alamatnya', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed connecting to 10.0.3.14:4001'))

    const result = await callGateway('/auth/login', { method: 'POST', body: {} })

    expect(result.status).toBe(503)
    expect(JSON.stringify(result)).not.toContain('10.0.3.14')
    expect(JSON.stringify(result)).not.toContain('4001')
  })

  test('respons yang bukan JSON tidak melempar', async () => {
    fetchMock.mockResolvedValue(new Response('<html>502</html>', { status: 502 }))

    await expect(callGateway('/auth/login', { method: 'POST' })).resolves.toMatchObject({
      ok: false,
      status: 502,
      data: null,
    })
  })
})

describe('respons galat untuk peramban', () => {
  test('mempertahankan status dan kode', async () => {
    const response = gatewayErrorResponse({
      ok: false,
      status: 409,
      data: null,
      error: { code: 'EMAIL_TAKEN', message: 'Surel sudah terdaftar' },
    })

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({
      error: { code: 'EMAIL_TAKEN', message: 'Surel sudah terdaftar' },
    })
  })

  test('galat tanpa keterangan tetap menghasilkan bentuk yang sama', async () => {
    const response = gatewayErrorResponse({ ok: false, status: 500, data: null, error: null })

    await expect(response.json()).resolves.toEqual({
      error: { code: 'UNKNOWN', message: 'Permintaan gagal.' },
    })
  })
})
