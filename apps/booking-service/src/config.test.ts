import { ConfigError } from '@tbe/shared-kernel'
import { describe, expect, test } from 'vitest'
import { loadConfig } from './config.js'

describe('konfigurasi', () => {
  test('port bawaan adalah 4006', () => {
    const config = loadConfig({ DATABASE_URL: 'postgresql://localhost:5433/booking' })

    expect(config.PORT).toBe(4006)
    expect(config.SERVICE_NAME).toBe('booking-service')
  })

  test('tanpa DATABASE_URL, startup gagal alih-alih berjalan dengan nilai bawaan', () => {
    expect(() => loadConfig({})).toThrow(ConfigError)
  })
})
