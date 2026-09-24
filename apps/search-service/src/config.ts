import { baseEnvSchema, createConfig } from '@tbe/shared-kernel'
import { z } from 'zod'

/** Satu-satunya tempat process.env dibaca, selain telemetry.ts. */
const envSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().default('search-service'),
  PORT: z.coerce.number().int().positive().max(65_535).default(4006),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  /**
   * Seberapa sering katalog di memori disegarkan dari Redis.
   *
   * Boleh panjang. Katalog adalah data STATIS: nama, alamat, koordinat. Yang
   * tidak boleh basi adalah harga, dan harga tidak pernah masuk ke katalog.
   */
  CATALOG_REFRESH_SECONDS: z.coerce.number().int().positive().default(300),

  /** TTL salinan katalog di Redis. Lebih panjang dari selang penyegaran. */
  CATALOG_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(3_600),

  /**
   * Seberapa sering kemunculan properti belum terpetakan disiram ke basis
   * data. Pencatatan tidak pernah ditunggu permintaan pencarian.
   */
  UNMAPPED_FLUSH_SECONDS: z.coerce.number().int().positive().default(30),

  SUGGESTION_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(600),

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
