import { describe, expect, test } from 'vitest'
import { ApiError } from './api-error'
import { createQueryClient } from './query-client'

/**
 * Kebijakan percobaan ulang.
 *
 * Diuji lewat opsi bawaan klien, bukan lewat fungsi yang diekspor khusus untuk
 * pengujian. Yang berlaku saat aplikasi berjalan adalah opsi ini — fungsi yang
 * diekspor terpisah dapat benar sementara opsinya lupa dipasang.
 */

function retryDecision(failureCount: number, error: Error): boolean {
  const retry = createQueryClient().getDefaultOptions().queries?.retry

  if (typeof retry !== 'function') throw new Error('kebijakan percobaan ulang bukan fungsi')

  return retry(failureCount, error)
}

function apiError(kind: ApiError['kind']): ApiError {
  return new ApiError({ kind, status: 500, code: 'X', message: 'pesan' })
}

describe('percobaan ulang kueri', () => {
  test('mengulang kegagalan jaringan dan galat server', () => {
    expect(retryDecision(0, apiError('network'))).toBe(true)
    expect(retryDecision(0, apiError('server'))).toBe(true)
  })

  test('tidak mengulang yang hasilnya pasti sama', () => {
    // Token kedaluwarsa dan masukan salah tidak berubah pada percobaan kedua;
    // mengulangnya hanya menunda pesan galat yang sudah benar.
    expect(retryDecision(0, apiError('unauthorized'))).toBe(false)
    expect(retryDecision(0, apiError('client'))).toBe(false)
    expect(retryDecision(0, apiError('rate_limited'))).toBe(false)
  })

  test('berhenti setelah dua percobaan', () => {
    expect(retryDecision(1, apiError('server'))).toBe(true)
    expect(retryDecision(2, apiError('server'))).toBe(false)
  })

  test('galat yang bukan dari lapisan API tidak diulang', () => {
    expect(retryDecision(0, new Error('entah apa'))).toBe(false)
  })
})

describe('opsi bawaan', () => {
  test('mutasi tidak pernah diulang otomatis', () => {
    // Permintaan yang mungkin sudah dikerjakan server — pemesanan, pembayaran —
    // tidak boleh dikirim dua kali hanya karena responsnya tidak sampai.
    expect(createQueryClient().getDefaultOptions().mutations?.retry).toBe(false)
  })

  test('tidak mengambil ulang setiap kali jendela difokuskan', () => {
    const queries = createQueryClient().getDefaultOptions().queries

    expect(queries?.refetchOnWindowFocus).toBe(false)
    expect(queries?.staleTime).toBeGreaterThan(0)
  })
})
