import { baseEnvSchema, createConfig } from '@tbe/shared-kernel'
import { CURRENCIES, ROUNDING_MODES } from '@tbe/money'
import { z } from 'zod'

/** Satu-satunya tempat process.env dibaca, selain telemetry.ts. */
const envSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().default('pricing-service'),
  PORT: z.coerce.number().int().positive().max(65_535).default(4005),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  /** Mata uang yang dilihat pengguna. Keputusan Q2: hanya IDR dan USD. */
  SELLING_CURRENCY: z.enum(CURRENCIES).default('IDR'),

  /**
   * Bankers' rounding sebagai bawaan: half_up membulatkan setiap nilai tengah
   * ke atas, dan pada jutaan transaksi bias itu menumpuk.
   */
  PRICE_ROUNDING: z.enum(ROUNDING_MODES).default('half_even'),

  /** PPN Indonesia. Basis poin: 1100 berarti 11%. */
  DEFAULT_TAX_BASIS_POINTS: z.coerce.number().int().min(0).max(10_000).default(1_100),
  DEFAULT_TAX_NAME: z.string().default('PPN'),

  /** Kurs di-cache; TTL pendek karena harga jual bergantung padanya. */
  RATE_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(300),

  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((value) => value.split(',').filter((origin) => origin.length > 0)),

  OTEL_ENABLED: z.enum(['true', 'false']).default('true'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default('http://localhost:4318/v1/traces'),
})

export type Config = z.infer<typeof envSchema>

export function loadConfig(): Config {
  return createConfig(envSchema, process.env)
}
