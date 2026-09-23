import { beforeEach, describe, expect, test, vi } from 'vitest'

/**
 * Cookie refresh token.
 *
 * Yang diuji di sini bukan bahwa Next dapat menyetel cookie, melainkan bahwa
 * atributnya benar. Satu atribut yang terlewat mengubah cookie ini dari
 * penyimpanan sesi yang aman menjadi sesuatu yang dapat dibaca skrip mana pun
 * atau ikut terkirim pada permintaan lintas situs — dan tidak ada gejala apa
 * pun yang menunjukkannya.
 */

const set = vi.fn()
const get = vi.fn()

vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ set, get }),
}))

const { REFRESH_COOKIE, clearRefreshCookie, readRefreshCookie, setRefreshCookie } =
  await import('./session-cookie')

beforeEach(() => {
  set.mockReset()
  get.mockReset()
})

function lastOptions(): Record<string, unknown> {
  return (set.mock.calls[0]?.[2] ?? {}) as Record<string, unknown>
}

describe('penyimpanan refresh token', () => {
  test('tidak dapat dibaca JavaScript halaman', async () => {
    // Satu celah XSS tidak boleh otomatis menjadi pencurian sesi.
    await setRefreshCookie('token-abc')

    expect(lastOptions().httpOnly).toBe(true)
  })

  test('tidak ikut terkirim pada permintaan lintas situs', async () => {
    await setRefreshCookie('token-abc')

    expect(lastOptions().sameSite).toBe('lax')
  })

  test('dibatasi pada seluruh situs dan punya masa berlaku', async () => {
    await setRefreshCookie('token-abc')

    expect(lastOptions().path).toBe('/')
    expect(lastOptions().maxAge).toBeGreaterThan(0)
  })

  test('menyimpan nilai token di bawah nama yang dipakai proxy', async () => {
    await setRefreshCookie('token-abc')

    expect(set.mock.calls[0]?.[0]).toBe(REFRESH_COOKIE)
    expect(set.mock.calls[0]?.[1]).toBe('token-abc')
  })
})

describe('pembacaan dan pembuangan', () => {
  test('mengembalikan nilai cookie bila ada', async () => {
    get.mockReturnValue({ value: 'token-abc' })

    await expect(readRefreshCookie()).resolves.toBe('token-abc')
  })

  test('mengembalikan undefined bila tidak ada sesi', async () => {
    get.mockReturnValue(undefined)

    await expect(readRefreshCookie()).resolves.toBeUndefined()
  })

  test('membuang cookie dengan masa berlaku nol, bukan sekadar mengosongkan nilainya', async () => {
    await clearRefreshCookie()

    expect(set.mock.calls[0]?.[1]).toBe('')
    expect(lastOptions().maxAge).toBe(0)
    expect(lastOptions().httpOnly).toBe(true)
  })
})
