import { baseEnvSchema, createConfig } from '@tbe/shared-kernel'
import { z } from 'zod'

/**
 * Satu-satunya tempat process.env dibaca, selain telemetry.ts — CONVENTIONS.md
 * bagian 12, ditegakkan aturan eslint `no-restricted-properties`.
 *
 * Dua kredensial Midtrans di bawah TIDAK punya nilai bawaan, dan itu disengaja.
 * Env yang tidak valid membuat proses BERHENTI, bukan jalan dengan nilai
 * bawaan — service pembayaran yang hidup dengan server key kosong akan menolak
 * setiap notifikasi yang sah sebagai tanda tangan palsu, dan gejalanya terlihat
 * seperti serangan alih-alih seperti kesalahan konfigurasi.
 */

const envSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().default('payment-service'),
  PORT: z.coerce.number().int().positive().max(65_535).default(4007),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  KAFKA_BROKERS: z.string().default('localhost:9092'),
  RABBITMQ_URL: z.string().default('amqp://tbe:tbe_local_dev@localhost:5673'),

  /**
   * Bahan tanda tangan notifikasi. Tanpa ini tidak ada notifikasi yang dapat
   * diverifikasi, jadi ketiadaannya wajib menggagalkan startup.
   */
  MIDTRANS_SERVER_KEY: z.string().min(1),

  /**
   * Dipakai peramban, bukan service ini — Snap.js membutuhkannya di sisi klien.
   * Tetap divalidasi di sini supaya penyebaran yang lupa mengisinya gagal saat
   * startup, bukan gagal di halaman pembayaran pengguna pertama.
   */
  MIDTRANS_CLIENT_KEY: z.string().min(1),

  MIDTRANS_SNAP_BASE_URL: z.url().default('https://app.sandbox.midtrans.com'),
  MIDTRANS_API_BASE_URL: z.url().default('https://api.sandbox.midtrans.com'),

  /**
   * Pembatasan laju endpoint webhook. Longgar dengan sengaja: yang memanggilnya
   * adalah penyedia, yang mengirim notifikasi berulang sebagai perilaku normal.
   */
  WEBHOOK_RATE_PER_MINUTE: z.coerce.number().int().positive().default(600),

  /** Kosong berarti CORS ditolak seluruhnya. Service ini tidak diakses peramban. */
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
