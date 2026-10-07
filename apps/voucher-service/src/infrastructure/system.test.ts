import { Registry } from 'prom-client'
import { describe, expect, test } from 'vitest'
import { OBJECT_TOKEN_LENGTH, voucherObjectKey } from '../domain/object-key.js'
import { createIssueMetrics } from './prom-metrics.js'
import { secureTokens, systemClock, uuidFactory } from './system.js'

describe('token kunci objek', () => {
  test('cukup panjang dan diterima pembentuk kunci', () => {
    const token = secureTokens.next()

    expect(token).toHaveLength(OBJECT_TOKEN_LENGTH)
    expect(voucherObjectKey(token)).toBe(`v/${token}.pdf`)
  })

  test('tidak berulang', () => {
    const tokens = new Set(Array.from({ length: 1_000 }, () => secureTokens.next()))

    expect(tokens.size).toBe(1_000)
  })

  test.each([
    ['terlalu pendek', 'abc'],
    ['berkarakter asing', `${'A'.repeat(42)}/`],
  ])('token yang %s ditolak', (_name, token) => {
    expect(() => voucherObjectKey(token)).toThrow('terlalu lemah')
  })
})

describe('jam dan pengenal', () => {
  test('pengenal adalah UUID', () => {
    expect(uuidFactory.next()).toMatch(/^[0-9a-f-]{36}$/)
  })

  test('jam mengembalikan waktu sekarang', () => {
    expect(Math.abs(systemClock.now().getTime() - Date.now())).toBeLessThan(1_000)
  })
})

describe('metrik M7', () => {
  test('latensi tercatat di histogram voucher_issue_latency_seconds', async () => {
    const registry = new Registry()
    createIssueMetrics(registry).observeIssueLatency(4)

    const text = await registry.metrics()

    expect(text).toContain('voucher_issue_latency_seconds_bucket{le="5"} 1')
    expect(text).toContain('voucher_issue_latency_seconds_count 1')
  })
})
