import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import { ConfigError } from '../errors/app-error.js'
import { baseEnvSchema, createConfig } from './config.js'

describe('createConfig', () => {
  test('mengembalikan nilai terparse ketika env sah', () => {
    const config = createConfig(baseEnvSchema, {
      SERVICE_NAME: 'booking-service',
      PORT: '3005',
      NODE_ENV: 'production',
    })

    expect(config.SERVICE_NAME).toBe('booking-service')
    expect(config.PORT).toBe(3005)
    expect(config.NODE_ENV).toBe('production')
  })

  test('mengubah PORT dari string menjadi angka', () => {
    const config = createConfig(baseEnvSchema, { SERVICE_NAME: 'a', PORT: '8080' })

    expect(config.PORT).toBe(8080)
    expect(typeof config.PORT).toBe('number')
  })

  test('menerapkan nilai bawaan untuk variabel opsional', () => {
    const config = createConfig(baseEnvSchema, { SERVICE_NAME: 'a' })

    expect(config.PORT).toBe(3000)
    expect(config.LOG_LEVEL).toBe('info')
    expect(config.NODE_ENV).toBe('development')
  })

  test('melempar ConfigError ketika variabel wajib tidak ada', () => {
    expect(() => createConfig(baseEnvSchema, {})).toThrow(ConfigError)
  })

  test('menyebut nama setiap variabel yang bermasalah', () => {
    const schema = baseEnvSchema.extend({
      DATABASE_URL: z.string().min(1),
      REDIS_URL: z.string().min(1),
    })

    let pesan = ''
    try {
      createConfig(schema, { SERVICE_NAME: 'a' })
    } catch (error) {
      pesan = error instanceof Error ? error.message : ''
    }

    expect(pesan).toContain('DATABASE_URL')
    expect(pesan).toContain('REDIS_URL')
  })

  test('tidak pernah membocorkan nilai yang diterima ke dalam pesan galat', () => {
    // Arrange — env yang salah tapi nilainya rahasia
    const schema = baseEnvSchema.extend({ PORT: z.coerce.number().int().max(100) })
    const rahasia = 'sk-live-jangan-sampai-tercatat'

    // Act
    let pesan = ''
    let detail = ''
    try {
      createConfig(schema, { SERVICE_NAME: 'a', PORT: rahasia })
    } catch (error) {
      pesan = error instanceof Error ? error.message : ''
      detail = error instanceof ConfigError ? JSON.stringify(error.details) : ''
    }

    // Assert — variabelnya disebut, nilainya tidak
    expect(pesan).toContain('PORT')
    expect(pesan).not.toContain(rahasia)
    expect(detail).not.toContain(rahasia)
  })

  test('menandai ConfigError sebagai non-operasional agar proses tidak melanjutkan', () => {
    try {
      createConfig(baseEnvSchema, {})
      throw new Error('seharusnya melempar')
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError)
      expect((error as ConfigError).isOperational).toBe(false)
    }
  })

  test('mencantumkan daftar variabel bermasalah pada details', () => {
    try {
      createConfig(baseEnvSchema, { PORT: 'bukan-angka' })
      throw new Error('seharusnya melempar')
    } catch (error) {
      const details = (error as ConfigError).details as { variables: string[] }
      expect(details.variables).toContain('SERVICE_NAME')
      expect(details.variables).toContain('PORT')
    }
  })

  test('menolak PORT di luar rentang yang sah', () => {
    expect(() => createConfig(baseEnvSchema, { SERVICE_NAME: 'a', PORT: '70000' })).toThrow(
      ConfigError,
    )
    expect(() => createConfig(baseEnvSchema, { SERVICE_NAME: 'a', PORT: '0' })).toThrow(ConfigError)
  })

  test('menolak LOG_LEVEL yang tidak dikenal', () => {
    expect(() => createConfig(baseEnvSchema, { SERVICE_NAME: 'a', LOG_LEVEL: 'verbose' })).toThrow(
      ConfigError,
    )
  })
})
