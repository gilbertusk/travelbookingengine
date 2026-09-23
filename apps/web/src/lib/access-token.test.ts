import { afterEach, describe, expect, test, vi } from 'vitest'
import { getAccessToken, setAccessToken, subscribeToAccessToken } from './access-token'

/**
 * Penyimpanan access token.
 *
 * Di memori, bukan di localStorage. Pengujian ini menjaga keputusan itu tetap
 * benar: token yang bocor ke penyimpanan peramban dapat dibaca skrip pihak
 * ketiga mana pun yang berhasil masuk ke halaman.
 */

afterEach(() => {
  setAccessToken(undefined)
})

describe('penyimpanan token', () => {
  test('menyimpan dan mengembalikan token', () => {
    setAccessToken('token-abc')

    expect(getAccessToken()).toBe('token-abc')
  })

  test('tidak menulis apa pun ke localStorage atau sessionStorage', () => {
    setAccessToken('token-abc')

    expect(window.localStorage.length).toBe(0)
    expect(window.sessionStorage.length).toBe(0)
  })

  test('membuang token saat disetel undefined', () => {
    setAccessToken('token-abc')
    setAccessToken(undefined)

    expect(getAccessToken()).toBeUndefined()
  })
})

describe('pemberitahuan perubahan', () => {
  test('memberi tahu pelanggan setiap kali token berganti', () => {
    const listener = vi.fn()
    subscribeToAccessToken(listener)

    setAccessToken('token-abc')
    setAccessToken(undefined)

    expect(listener).toHaveBeenCalledTimes(2)
  })

  test('berhenti memberi tahu setelah berhenti berlangganan', () => {
    // Pelanggan yang tertinggal setelah komponennya dilepas adalah kebocoran
    // memori yang tumbuh setiap kali pengguna berpindah halaman.
    const listener = vi.fn()
    const unsubscribe = subscribeToAccessToken(listener)

    unsubscribe()
    setAccessToken('token-abc')

    expect(listener).not.toHaveBeenCalled()
  })
})
