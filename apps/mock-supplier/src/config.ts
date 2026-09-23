import { baseEnvSchema, createConfig } from '@tbe/shared-kernel'
import { z } from 'zod'

/**
 * Satu-satunya tempat process.env boleh dibaca — ditegakkan oleh aturan lint
 * pada packages/eslint-config/node.js.
 */

const envSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().default('mock-supplier'),
  PORT: z.coerce.number().int().positive().max(65_535).default(4000),
  /** Menonaktifkan seluruh latensi tiruan; dipakai pada uji integrasi. */
  MOCK_SUPPLIER_INSTANT: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  OTEL_ENABLED: z.enum(['true', 'false']).default('true'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default('http://localhost:4318/v1/traces'),
})

export type Config = z.infer<typeof envSchema>

export function loadConfig(): Config {
  return createConfig(envSchema, process.env)
}
