import { describe, expect, test } from 'vitest'
import { OpsError } from './ops-client'
import { createQueryClient, shouldRetry } from './query-client'

describe('kebijakan percobaan ulang', () => {
  test('4xx tidak diulang; 5xx dan galat jaringan diulang sekali', () => {
    expect(shouldRetry(0, new OpsError(403, 'FORBIDDEN', 'x'))).toBe(false)
    expect(shouldRetry(0, new OpsError(503, 'UPSTREAM', 'x'))).toBe(true)
    expect(shouldRetry(1, new TypeError('fetch failed'))).toBe(false)
  })

  test('data operator selalu dianggap basi, mutasi tidak pernah diulang', () => {
    const defaults = createQueryClient().getDefaultOptions()

    expect(defaults.queries?.staleTime).toBe(0)
    expect(defaults.mutations?.retry).toBe(false)
  })
})
