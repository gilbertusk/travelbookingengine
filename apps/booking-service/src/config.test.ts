import { ConfigError } from '@tbe/shared-kernel'
import { describe, expect, test } from 'vitest'
import { loadConfig } from './config.js'

const REQUIRED = {
  DATABASE_URL: 'postgresql://localhost:5433/booking',
  REDIS_URL: 'redis://localhost:6380',
  RABBITMQ_URL: 'amqp://localhost:5672',
}

describe('konfigurasi', () => {
  test('port bawaan adalah 4006', () => {
    const config = loadConfig(REQUIRED)

    expect(config.PORT).toBe(4006)
    expect(config.HOLD_DURATION_MS).toBe(15 * 60 * 1_000)
    expect(config.SERVICE_NAME).toBe('booking-service')
  })

  test('tanpa DATABASE_URL, startup gagal alih-alih berjalan dengan nilai bawaan', () => {
    expect(() => loadConfig({ ...REQUIRED, DATABASE_URL: undefined })).toThrow(ConfigError)
  })

  test('tanpa REDIS_URL, startup gagal: tanpa Redis tidak ada jaminan hold', () => {
    expect(() => loadConfig({ ...REQUIRED, REDIS_URL: undefined })).toThrow(ConfigError)
  })

  test('tanpa RABBITMQ_URL, startup gagal: saga tanpa RabbitMQ tidak dapat meminta refund', () => {
    expect(() => loadConfig({ ...REQUIRED, RABBITMQ_URL: undefined })).toThrow(ConfigError)
  })

  test('sewa langkah saga yang tidak cukup untuk dua panggilan ke hulu ditolak', () => {
    // Sewa yang lebih pendek dari langkahnya membuat pemulih mengambil alih
    // proses yang masih hidup.
    expect(() =>
      loadConfig({ ...REQUIRED, UPSTREAM_TIMEOUT_MS: '20000', SAGA_STEP_LEASE_MS: '60000' }),
    ).toThrow(/SAGA_STEP_LEASE_MS/)
  })

  test('batas tunggu koneksi yang menghabiskan sewa langkah saga ditolak', () => {
    expect(() =>
      loadConfig({ ...REQUIRED, DATABASE_TX_MAX_WAIT_MS: '30000', SAGA_STEP_LEASE_MS: '60000' }),
    ).toThrow(/DATABASE_TX_MAX_WAIT_MS/)
  })

  test('kolam koneksi dan batas tunggunya punya bawaan untuk lonjakan (Step 22)', () => {
    const config = loadConfig(REQUIRED)

    expect(config.DATABASE_POOL_MAX).toBe(20)
    expect(config.DATABASE_TX_MAX_WAIT_MS).toBe(5_000)
  })

  test('batas menunggu saga yang lebih pendek dari jenjang percobaan perintah ditolak', () => {
    // Menyerah sebelum supplier-service selesai mencoba berarti NEEDS_REVIEW
    // untuk pemesanan yang masih dikerjakan.
    expect(() => loadConfig({ ...REQUIRED, SAGA_CONFIRM_TIMEOUT_MS: '60000' })).toThrow(
      /SAGA_CONFIRM_TIMEOUT_MS/,
    )
    expect(() => loadConfig({ ...REQUIRED, SAGA_REFUND_TIMEOUT_MS: '60000' })).toThrow(
      /SAGA_REFUND_TIMEOUT_MS/,
    )
  })
})
