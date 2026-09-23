import { baseEnvSchema, createConfig } from '@tbe/shared-kernel'
import { z } from 'zod'

/**
 * Satu-satunya tempat process.env boleh dibaca, selain telemetry.ts yang harus
 * berjalan lebih dulu. Ditegakkan oleh aturan lint.
 */

/**
 * Panjang minimum rahasia JWT.
 *
 * HS256 memakai HMAC-SHA256, jadi rahasia di bawah 32 byte memberi entropi
 * kurang dari keluaran algoritmanya sendiri. Tidak ada nilai bawaan: service
 * yang menyala dengan rahasia bawaan adalah service yang tokennya dapat
 * dipalsukan siapa pun yang pernah membaca repositori ini.
 */
const MIN_JWT_SECRET_LENGTH = 32

const envSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().default('auth-service'),
  PORT: z.coerce.number().int().positive().max(65_535).default(4002),

  DATABASE_URL: z.string().min(1),

  JWT_SECRET: z.string().min(MIN_JWT_SECRET_LENGTH),
  JWT_ISSUER: z.string().default('tbe-auth'),
  JWT_AUDIENCE: z.string().default('tbe-api'),

  /** Pendek karena access token tidak dapat dicabut. */
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().max(3_600).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().max(90).default(30),

  LOGIN_MAX_FAILURES: z.coerce.number().int().positive().default(8),
  LOGIN_FAILURE_WINDOW_MINUTES: z.coerce.number().int().positive().default(15),

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
