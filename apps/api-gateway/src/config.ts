import { baseEnvSchema, createConfig } from '@tbe/shared-kernel'
import { z } from 'zod'

/**
 * Satu-satunya tempat process.env boleh dibaca, selain telemetry.ts.
 */

const MIN_JWT_SECRET_LENGTH = 32

const serviceUrl = (port: number): z.ZodDefault<z.ZodURL> =>
  z.url().default(`http://localhost:${String(port)}`)

const envSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().default('api-gateway'),
  PORT: z.coerce.number().int().positive().max(65_535).default(4001),

  /**
   * Rahasia yang sama dengan auth-service. Gateway hanya memverifikasi, tidak
   * pernah menerbitkan — tetapi HS256 memakai kunci simetris, jadi keduanya
   * memegang nilai yang sama. Beralih ke RS256 akan menghapus kebutuhan itu,
   * dan layak dipertimbangkan sebelum produksi.
   */
  JWT_SECRET: z.string().min(MIN_JWT_SECRET_LENGTH),
  JWT_ISSUER: z.string().default('tbe-auth'),
  JWT_AUDIENCE: z.string().default('tbe-api'),

  REDIS_URL: z.string().min(1),

  AUTH_SERVICE_URL: serviceUrl(4002),
  SEARCH_SERVICE_URL: serviceUrl(4003),
  PRICING_SERVICE_URL: serviceUrl(4005),
  BOOKING_SERVICE_URL: serviceUrl(4006),
  PAYMENT_SERVICE_URL: serviceUrl(4007),
  VOUCHER_SERVICE_URL: serviceUrl(4008),
  ANALYTICS_SERVICE_URL: serviceUrl(4010),

  /** Kosong berarti seluruh asal ditolak — bawaan yang aman. */
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((value) => value.split(',').filter((origin) => origin.length > 0)),

  BODY_LIMIT: z.string().default('1mb'),

  OTEL_ENABLED: z.enum(['true', 'false']).default('true'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default('http://localhost:4318/v1/traces'),
})

export type Config = z.infer<typeof envSchema>

export function loadConfig(): Config {
  return createConfig(envSchema, process.env)
}
