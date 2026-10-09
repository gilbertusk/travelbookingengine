import { RETRY_TIERS } from '@tbe/messaging'
import { baseEnvSchema, createConfig } from '@tbe/shared-kernel'
import { z } from 'zod'

/**
 * Satu-satunya tempat process.env dibaca — CONVENTIONS.md bagian 12,
 * ditegakkan aturan eslint `no-restricted-properties`.
 *
 * Step 19 menambah Kafka dan RabbitMQ: saga menerbitkan peristiwa dan perintah
 * lewat outbox, dan mendengarkan jawaban payment-service dan supplier-service.
 */

const MINUTE_MS = 60_000

/**
 * Lama perintah RabbitMQ dapat berada di jenjang tunda sebelum masuk dead
 * letter (Step 05). Batas menunggu saga yang lebih pendek dari ini
 * menyerah pada jawaban yang masih akan datang — dan untuk konfirmasi
 * supplier, menyerah berarti NEEDS_REVIEW untuk pemesanan yang sebenarnya
 * masih dicoba.
 */
const COMMAND_RETRY_SPAN_MS = RETRY_TIERS.reduce((total, tier) => total + tier.delayMs, 0)

const positiveMs = (fallback: number) => z.coerce.number().int().positive().default(fallback)

const envSchema = baseEnvSchema
  .extend({
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

    /** Daftar broker dipisah koma. Port 29092 adalah pendengar luar Kafka di infra. */
    KAFKA_BROKERS: z.string().min(1).default('localhost:29092'),
    KAFKA_CONSUMER_GROUP: z.string().min(1).default('booking-service.saga'),
    /**
     * Tanpa nilai bawaan: URL-nya membawa kredensial, dan kredensial tidak
     * boleh ada di kode sumber (NFR-12). Saga tanpa RabbitMQ tidak dapat
     * meminta refund.
     */
    RABBITMQ_URL: z.string().min(1),

    SUPPLIER_SERVICE_URL: z.string().min(1).default('http://localhost:4004'),
    PRICING_SERVICE_URL: z.string().min(1).default('http://localhost:4005'),
    PAYMENT_SERVICE_URL: z.string().min(1).default('http://localhost:4007'),
    /** Katalog properti — zona waktu untuk tenggat pembatalan (Step 25). */
    SEARCH_SERVICE_URL: z.string().min(1).default('http://localhost:4003'),
    /**
     * Ukuran kolam koneksi Postgres per instance. Bawaan pg adalah 10, dan uji
     * beban Step 22 menghabiskannya: seribu price check serentak, transaksi
     * yang tidak mendapat koneksi dalam batas tunggu, dan hold yang gagal di
     * TENGAH saga — kursinya tertahan sampai sewa habis dan pemulih
     * mengompensasinya. Dua puluh per instance tetap jauh di bawah batas
     * koneksi Postgres bawaan (100) untuk beberapa instance sekaligus.
     */
    DATABASE_POOL_MAX: z.coerce.number().int().positive().max(200).default(20),
    /**
     * Batas menunggu koneksi untuk memulai transaksi. Bawaan Prisma 2 detik —
     * terlalu pendek untuk lonjakan; permintaan yang menunggu sebentar lebih
     * baik daripada langkah saga yang gagal setengah jalan. Dibatasi oleh sewa
     * saga (lihat superRefine).
     */
    DATABASE_TX_MAX_WAIT_MS: positiveMs(5_000),
    /** Batas waktu satu panggilan ke supplier-service atau pricing-service. */
    UPSTREAM_TIMEOUT_MS: positiveMs(5_000),

    /** Durasi hold lokal. Lima belas menit: cukup untuk membayar, tidak cukup untuk lupa. */
    HOLD_DURATION_MS: positiveMs(15 * MINUTE_MS),
    /** Selang penyapu hold. Batas atas keterlambatan pelepasan bila keyspace hilang. */
    HOLD_SWEEP_INTERVAL_MS: positiveMs(30_000),
    HOLD_SWEEP_BATCH: z.coerce.number().int().positive().max(1_000).default(100),

    /**
     * Sewa proses untuk langkah langsung saga. Harus lebih panjang dari
     * langkah terlama — hold memanggil supplier-service lalu pricing-service,
     * masing-masing sampai UPSTREAM_TIMEOUT_MS. Sewa yang lebih pendek membuat
     * pemulih mengambil alih proses yang masih hidup.
     */
    SAGA_STEP_LEASE_MS: positiveMs(MINUTE_MS),
    /** Batas menunggu jawaban supplier.confirm sebelum saga menyerah ke peninjauan. */
    SAGA_CONFIRM_TIMEOUT_MS: positiveMs(15 * MINUTE_MS),
    /** Batas menunggu konfirmasi refund sebelum kompensasi dianggap gagal. */
    SAGA_REFUND_TIMEOUT_MS: positiveMs(15 * MINUTE_MS),
    SAGA_COMPENSATION_MAX_ATTEMPTS: z.coerce.number().int().positive().max(20).default(5),
    SAGA_COMPENSATION_RETRY_MS: positiveMs(30_000),
    SAGA_SWEEP_INTERVAL_MS: positiveMs(10_000),
    SAGA_SWEEP_BATCH: z.coerce.number().int().positive().max(1_000).default(100),

    /** Selang penerbit outbox saat antrean kosong. */
    OUTBOX_POLL_INTERVAL_MS: positiveMs(500),
    OUTBOX_BATCH: z.coerce.number().int().positive().max(1_000).default(100),
    /** Batas transaksi penerbit, yang memegang kunci penasihat selama satu batch. */
    OUTBOX_TX_TIMEOUT_MS: positiveMs(30_000),

    STATUS_STREAM_POLL_MS: positiveMs(1_000),
    STATUS_STREAM_HEARTBEAT_MS: positiveMs(15_000),

    OTEL_ENABLED: z.enum(['true', 'false']).default('true'),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default('http://localhost:4318/v1/traces'),
  })
  .superRefine((env, context) => {
    // Satu langkah hold memulai lebih dari satu transaksi. Menunggu koneksi
    // dua kali saja tidak boleh menghabiskan sewa: pemulih akan mengambil
    // alih langkah yang prosesnya masih hidup.
    if (2 * env.DATABASE_TX_MAX_WAIT_MS >= env.SAGA_STEP_LEASE_MS) {
      context.addIssue({
        code: 'custom',
        path: ['DATABASE_TX_MAX_WAIT_MS'],
        message: 'dua kali batas tunggu harus lebih pendek dari SAGA_STEP_LEASE_MS',
      })
    }
    // Hold memanggil dua service berurutan; sewa minimal tiga kali batas
    // waktunya memberi ruang untuk keduanya dan untuk basis data.
    if (env.SAGA_STEP_LEASE_MS <= 3 * env.UPSTREAM_TIMEOUT_MS) {
      context.addIssue({
        code: 'custom',
        path: ['SAGA_STEP_LEASE_MS'],
        message: 'harus lebih dari tiga kali UPSTREAM_TIMEOUT_MS',
      })
    }
    for (const key of ['SAGA_CONFIRM_TIMEOUT_MS', 'SAGA_REFUND_TIMEOUT_MS'] as const) {
      if (env[key] <= COMMAND_RETRY_SPAN_MS) {
        context.addIssue({
          code: 'custom',
          path: [key],
          message: `harus lebih dari jenjang percobaan perintah (${String(COMMAND_RETRY_SPAN_MS)} ms)`,
        })
      }
    }
  })

export type Config = z.infer<typeof envSchema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return createConfig(envSchema, env)
}
