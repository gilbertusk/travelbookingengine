import { baseEnvSchema, createConfig } from '@tbe/shared-kernel'
import { z } from 'zod'

/**
 * Satu-satunya tempat process.env dibaca, selain telemetry.ts — CONVENTIONS.md
 * bagian 12. Env yang tidak valid membuat proses BERHENTI.
 */

const envSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().default('analytics-service'),
  PORT: z.coerce.number().int().positive().max(65_535).default(4010),

  DATABASE_URL: z.string().min(1),

  KAFKA_BROKERS: z.string().default('localhost:29092'),
  /**
   * Group SENDIRI, terpisah dari setiap service lain. Inilah yang membuat
   * analitik membaca seluruh topik tanpa menggeser offset siapa pun, dan
   * yang diputar ulang oleh `pnpm replay`.
   */
  KAFKA_GROUP_ID: z.string().min(1).default('analytics-service'),

  /** Rentang bawaan laporan bila panel tidak menyebutnya. */
  SUMMARY_DEFAULT_DAYS: z.coerce.number().int().positive().max(366).default(30),

  OTEL_ENABLED: z.enum(['true', 'false']).default('true'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default('http://localhost:4318/v1/traces'),
})

export type Config = z.infer<typeof envSchema>

export function loadConfig(): Config {
  return createConfig(envSchema, process.env)
}
