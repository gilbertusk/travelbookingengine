import { baseEnvSchema, createConfig } from '@tbe/shared-kernel'
import { z } from 'zod'

/**
 * Satu-satunya tempat process.env dibaca — CONVENTIONS.md bagian 12,
 * ditegakkan aturan eslint `no-restricted-properties`.
 *
 * Step 16 belum punya proses yang berjalan, jadi belum ada yang memanggil
 * [loadConfig] selain ujinya sendiri. Berkas ini tetap ada sekarang karena ia
 * adalah KONTRAK env service ini, dan .env.example harus sepakat dengannya
 * sejak migrasi pertama dijalankan — prisma.config.ts membaca DATABASE_URL
 * yang sama.
 *
 * Tidak ada REDIS_URL, KAFKA_BROKERS, maupun RABBITMQ_URL. Step 16 domain
 * murni; variabel untuk infrastruktur yang belum dipakai hanya membuat
 * penyebaran gagal karena kekurangan nilai yang tidak dibaca siapa pun.
 */

const envSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().default('booking-service'),
  PORT: z.coerce.number().int().positive().max(65_535).default(4006),

  /** Tanpa nilai bawaan: service pemesanan tanpa basis data tidak berarti apa-apa. */
  DATABASE_URL: z.string().min(1),
})

export type Config = z.infer<typeof envSchema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return createConfig(envSchema, env)
}
