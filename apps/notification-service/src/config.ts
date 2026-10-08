import { baseEnvSchema, createConfig } from '@tbe/shared-kernel'
import { z } from 'zod'

/**
 * Satu-satunya tempat process.env dibaca, selain telemetry.ts — CONVENTIONS.md
 * bagian 12. Env yang tidak valid membuat proses BERHENTI.
 */

const optionalString = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().min(1).optional(),
)

const envSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().default('notification-service'),
  PORT: z.coerce.number().int().positive().max(65_535).default(4009),

  DATABASE_URL: z.string().min(1),

  KAFKA_BROKERS: z.string().default('localhost:29092'),
  /** Satu group untuk seluruh instance: setiap peristiwa dibaca satu kali. */
  KAFKA_GROUP_ID: z.string().min(1).default('notification-service'),
  RABBITMQ_URL: z.string().default('amqp://tbe:tbe_local_dev@localhost:5672'),

  BOOKING_SERVICE_URL: z.url().default('http://localhost:4006'),
  VOUCHER_SERVICE_URL: z.url().default('http://localhost:4008'),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(3_000),

  SMTP_HOST: z.string().min(1).default('localhost'),
  SMTP_PORT: z.coerce.number().int().positive().max(65_535).default(1025),
  /** `true` untuk TLS sejak sambungan dibuka (port 465). Mailpit tidak memakainya. */
  SMTP_SECURE: z.enum(['true', 'false']).default('false'),
  SMTP_USER: optionalString,
  SMTP_PASSWORD: optionalString,
  SMTP_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  MAIL_FROM: z.string().min(3).default('Lintang <bantuan@lintang.local>'),

  /**
   * Selang putaran penghantar. Penghantar juga dibangunkan setiap kali
   * pemberitahuan baru dicatat, jadi selang ini hanya menentukan seberapa
   * cepat percobaan ULANG yang jatuh tempo diambil.
   */
  DELIVERY_INTERVAL_MS: z.coerce.number().int().positive().default(1_000),
  DELIVERY_BATCH_SIZE: z.coerce.number().int().positive().max(500).default(20),
  /** Lebih lama dari satu pengiriman SMTP terlama, termasuk batas waktunya. */
  DELIVERY_LEASE_MS: z.coerce.number().int().positive().default(60_000),

  /**
   * Rahasia HMAC untuk kunci penerima (pembatasan laju). Tanpa nilai bawaan:
   * kunci yang dihitung dengan rahasia yang dapat ditebak sama saja dengan
   * hash polos alamat surel.
   */
  RECIPIENT_KEY_SECRET: z.string().min(32),

  /** Surel per penerima per jam. Pemesanan wajar menghasilkan tiga atau empat. */
  RATE_LIMIT_PER_HOUR: z.coerce.number().int().positive().default(10),
  /** Peristiwa yang lebih tua dari ini tidak dikirimi surel. Lihat domain/policy.ts. */
  MAX_EVENT_AGE_HOURS: z.coerce.number().positive().default(48),

  NOTIFICATION_PREFETCH: z.coerce.number().int().positive().max(64).default(8),

  OTEL_ENABLED: z.enum(['true', 'false']).default('true'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default('http://localhost:4318/v1/traces'),
})

export type Config = z.infer<typeof envSchema>

export function loadConfig(): Config {
  return createConfig(envSchema, process.env)
}
