import { baseEnvSchema, createConfig } from '@tbe/shared-kernel'
import { z } from 'zod'

/**
 * Satu-satunya tempat process.env dibaca, selain telemetry.ts — CONVENTIONS.md
 * bagian 12. Env yang tidak valid membuat proses BERHENTI.
 *
 * Kredensial MinIO tidak punya nilai bawaan, dan itu disengaja: service yang
 * hidup tanpa kredensial akan menerima perintah voucher, gagal mengunggah
 * setiap berkas, dan mengisi antrian tunda sampai dead letter — gejalanya
 * terlihat seperti MinIO yang mati, bukan seperti kesalahan konfigurasi.
 */

const envSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().default('voucher-service'),
  PORT: z.coerce.number().int().positive().max(65_535).default(4008),

  DATABASE_URL: z.string().min(1),

  KAFKA_BROKERS: z.string().default('localhost:29092'),
  RABBITMQ_URL: z.string().default('amqp://tbe:tbe_local_dev@localhost:5672'),

  BOOKING_SERVICE_URL: z.url().default('http://localhost:4006'),
  SEARCH_SERVICE_URL: z.url().default('http://localhost:4003'),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(3_000),

  /** Alamat MinIO yang dijangkau service ini untuk menulis. */
  MINIO_URL: z.url().default('http://localhost:9000'),
  /**
   * Alamat MinIO yang akan dibuka PERAMBAN. URL unduhan ditandatangani untuk
   * alamat ini — tanda tangan S3 mencakup nama host. Kosong berarti sama
   * dengan MINIO_URL, yang benar untuk pengembangan lokal.
   */
  MINIO_PUBLIC_URL: z.preprocess((value) => (value === '' ? undefined : value), z.url().optional()),
  MINIO_ACCESS_KEY: z.string().min(1),
  MINIO_SECRET_KEY: z.string().min(1),
  MINIO_BUCKET: z.string().min(3).default('vouchers'),

  /**
   * Perintah voucher yang dikerjakan bersamaan oleh satu proses. Penyusunan
   * PDF ringan tetapi menunggu tiga panggilan jaringan; prefetch kecil menjaga
   * satu perintah yang tersendat tidak menahan perintah lain di belakangnya.
   */
  VOUCHER_PREFETCH: z.coerce.number().int().positive().max(64).default(4),

  OTEL_ENABLED: z.enum(['true', 'false']).default('true'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default('http://localhost:4318/v1/traces'),
})

export type Config = z.infer<typeof envSchema>

export function loadConfig(): Config {
  return createConfig(envSchema, process.env)
}
