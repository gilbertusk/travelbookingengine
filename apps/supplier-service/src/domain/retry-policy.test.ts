import { describe, expect, test } from 'vitest'
import type { SupplierError } from '@tbe/supplier-adapters'
import { DEFAULT_RETRY_POLICY, decideRetry, delayFor } from './retry-policy.js'

/**
 * Kebijakan percobaan ulang.
 *
 * Seluruhnya diturunkan dari jenis kegagalan yang dibedakan Step 10 — dan
 * inilah pembayaran atas pembedaan yang di sana terlihat berlebihan.
 */

function error(kind: SupplierError['kind'], extra: Record<string, unknown> = {}): SupplierError {
  return { supplier: 'SKY', operation: 'search', kind, ...extra } as SupplierError
}

/** Jitter tetap, supaya angkanya dapat diperiksa. */
const half = () => 0.5

describe('apa yang layak dicoba ulang', () => {
  test('kegagalan sementara layak diulang', () => {
    for (const kind of ['timeout', 'unavailable', 'rate_limited', 'upstream_error'] as const) {
      expect(decideRetry(error(kind), 1, DEFAULT_RETRY_POLICY, half).retry).toBe(true)
    }
  })

  test('jawaban sah tidak diulang', () => {
    for (const kind of ['sold_out', 'not_found', 'price_changed', 'hold_expired'] as const) {
      const decision = decideRetry(error(kind), 1, DEFAULT_RETRY_POLICY, half)
      expect(decision.retry).toBe(false)
      if (decision.retry) return
      expect(decision.reason).toBe('not_retryable')
    }
  })

  test('respons cacat TIDAK diulang', () => {
    // Supplier yang mengirim isi tidak dapat diurai akan mengirimkannya lagi.
    // Yang dibutuhkan orang, bukan percobaan kedua yang menutupi gejalanya.
    const decision = decideRetry(error('invalid_response'), 1, DEFAULT_RETRY_POLICY, half)

    expect(decision.retry).toBe(false)
  })

  test('berhenti setelah batas percobaan', () => {
    const decision = decideRetry(
      error('timeout'),
      DEFAULT_RETRY_POLICY.maxAttempts,
      DEFAULT_RETRY_POLICY,
      half,
    )

    expect(decision.retry).toBe(false)
    if (decision.retry) return
    expect(decision.reason).toBe('attempts_exhausted')
  })
})

describe('backoff', () => {
  test('jeda tumbuh eksponensial menurut nomor percobaan', () => {
    const first = delayFor(error('timeout'), 1, DEFAULT_RETRY_POLICY, () => 1)
    const second = delayFor(error('timeout'), 2, DEFAULT_RETRY_POLICY, () => 1)
    const third = delayFor(error('timeout'), 3, DEFAULT_RETRY_POLICY, () => 1)

    expect(second).toBe(first * 2)
    expect(third).toBe(first * 4)
  })

  test('jeda tidak melewati batas atas', () => {
    const delay = delayFor(error('timeout'), 20, DEFAULT_RETRY_POLICY, () => 1)

    expect(delay).toBe(DEFAULT_RETRY_POLICY.maxDelayMs)
  })

  test('jitter menyebarkan percobaan, bukan menumpuknya di satu titik', () => {
    // Tanpa jitter, seluruh permintaan yang gagal bersamaan akan dicoba ulang
    // bersamaan juga — supplier yang baru tumbang menerima gelombang kedua
    // tepat pada detik yang sama.
    const values = [0, 0.25, 0.5, 0.75, 0.99].map((value) =>
      delayFor(error('timeout'), 3, DEFAULT_RETRY_POLICY, () => value),
    )

    expect(new Set(values).size).toBe(values.length)
    expect(Math.min(...values)).toBe(0)
  })

  test('kuota habis menunggu jauh lebih lama daripada batas waktu', () => {
    const rateLimited = delayFor(error('rate_limited'), 1, DEFAULT_RETRY_POLICY, half)
    const timeout = delayFor(error('timeout'), 1, DEFAULT_RETRY_POLICY, half)

    expect(rateLimited).toBeGreaterThan(timeout)
  })

  test('jeda yang diminta supplier dihormati', () => {
    // Menunggu lebih sebentar dari yang diminta adalah cara tercepat membuat
    // pembatasan laju supplier menjadi pemblokiran.
    const delay = delayFor(
      error('rate_limited', { retryAfterSeconds: 30 }),
      1,
      DEFAULT_RETRY_POLICY,
      () => 0,
    )

    expect(delay).toBe(30_000)
  })

  test('jitter tetap ditambahkan di atas jeda yang diminta', () => {
    const delay = delayFor(
      error('rate_limited', { retryAfterSeconds: 30 }),
      1,
      DEFAULT_RETRY_POLICY,
      () => 1,
    )

    expect(delay).toBeGreaterThan(30_000)
  })
})
