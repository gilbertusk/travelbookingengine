import { baseEnvSchema, createConfig } from '@tbe/shared-kernel'
import { z } from 'zod'

/**
 * Satu-satunya tempat process.env dibaca, selain telemetry.ts.
 *
 * Kredensial supplier juga dibaca di sini — bukan dari basis data. Tabel
 * `suppliers` hanya menyimpan NAMA variabelnya; nilainya tidak pernah
 * menyentuh penyimpanan.
 */

const envSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().default('supplier-service'),
  PORT: z.coerce.number().int().positive().max(65_535).default(4004),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  /** Satu proses menyajikan kelima supplier tiruan; di produksi berbeda-beda. */
  SUPPLIER_BASE_URL: z.url().default('http://localhost:4000'),

  KAFKA_BROKERS: z.string().default('localhost:9092'),
  RABBITMQ_URL: z.string().default('amqp://tbe:tbe_local_dev@localhost:5673'),

  /** Token per detik yang boleh dikirim ke SATU supplier. NFR-14. */
  SUPPLIER_RATE_PER_SECOND: z.coerce.number().int().positive().default(20),
  SUPPLIER_RATE_BURST: z.coerce.number().int().positive().default(40),

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
