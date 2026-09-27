import { ConfigError } from '@tbe/shared-kernel'
import { describe, expect, test } from 'vitest'
import { loadConfig } from './config.js'

describe('konfigurasi', () => {
  test('port bawaan adalah 4006', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgresql://localhost:5433/booking',
      REDIS_URL: 'redis://localhost:6380',
    })

    expect(config.PORT).toBe(4006)
    expect(config.HOLD_DURATION_MS).toBe(15 * 60 * 1_000)
    expect(config.SERVICE_NAME).toBe('booking-service')
  })

  test('tanpa DATABASE_URL, startup gagal alih-alih berjalan dengan nilai bawaan', () => {
    expect(() => loadConfig({ REDIS_URL: 'redis://localhost:6380' })).toThrow(ConfigError)
  })

  test('tanpa REDIS_URL, startup gagal: tanpa Redis tidak ada jaminan hold', () => {
    expect(() => loadConfig({ DATABASE_URL: 'postgresql://localhost:5433/booking' })).toThrow(
      ConfigError,
    )
  })
})
