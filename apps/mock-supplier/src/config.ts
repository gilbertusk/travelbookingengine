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
  /**
   * Umur hold bawaan dalam milidetik. Tanpa nilai: 15 menit. Uji integrasi
   * Step 20 memendekkannya untuk membuktikan hold supplier habis sendiri —
   * kompensasi `lapses` yang diputuskan di Step 19.
   */
  MOCK_SUPPLIER_HOLD_TTL_MS: z.coerce.number().int().positive().optional(),
  OTEL_ENABLED: z.enum(['true', 'false']).default('true'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default('http://localhost:4318/v1/traces'),
})

export type Config = z.infer<typeof envSchema>

export function loadConfig(): Config {
  return createConfig(envSchema, process.env)
}
