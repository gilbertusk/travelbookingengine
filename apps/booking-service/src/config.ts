import { baseEnvSchema, createConfig } from '@tbe/shared-kernel'
import { z } from 'zod'

/**
 * Satu-satunya tempat process.env dibaca — CONVENTIONS.md bagian 12,
 * ditegakkan aturan eslint `no-restricted-properties`.
 *
 * Tidak ada KAFKA_BROKERS maupun RABBITMQ_URL: booking-service belum
 * menerbitkan apa pun sampai outbox Step 19. Variabel untuk infrastruktur yang
 * belum dipakai hanya membuat penyebaran gagal karena kekurangan nilai yang
 * tidak dibaca siapa pun.
 */

const envSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().default('booking-service'),
  PORT: z.coerce.number().int().positive().max(65_535).default(4006),

  /** Tanpa nilai bawaan: service pemesanan tanpa basis data tidak berarti apa-apa. */
  DATABASE_URL: z.string().min(1),

  /**
   * Redis untuk hold lokal. Tanpa nilai bawaan: tanpa Redis tidak ada jaminan
   * US-04, dan service yang tetap menerima hold tanpanya menjual kamar yang
   * sama dua kali.
   */
  REDIS_URL: z.string().min(1),
  /** Nomor basis data Redis; menentukan kanal keyspace notification yang didengar. */
  REDIS_DB: z.coerce.number().int().min(0).max(15).default(0),

  SUPPLIER_SERVICE_URL: z.string().min(1).default('http://localhost:4004'),
  PRICING_SERVICE_URL: z.string().min(1).default('http://localhost:4005'),
  /** Batas waktu satu panggilan ke supplier-service atau pricing-service. */
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),

  /** Durasi hold lokal. Lima belas menit: cukup untuk membayar, tidak cukup untuk lupa. */
  HOLD_DURATION_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 60 * 1_000),
  /** Selang penyapu hold. Batas atas keterlambatan pelepasan bila keyspace hilang. */
  HOLD_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  HOLD_SWEEP_BATCH: z.coerce.number().int().positive().max(1_000).default(100),

  OTEL_ENABLED: z.enum(['true', 'false']).default('true'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default('http://localhost:4318/v1/traces'),
})

export type Config = z.infer<typeof envSchema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return createConfig(envSchema, env)
}
