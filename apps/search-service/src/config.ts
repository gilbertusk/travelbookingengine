import { baseEnvSchema, createConfig } from '@tbe/shared-kernel'
import { z } from 'zod'

/** Satu-satunya tempat process.env dibaca, selain telemetry.ts. */
const envSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().default('search-service'),
  PORT: z.coerce.number().int().positive().max(65_535).default(4003),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  /**
   * Seberapa sering katalog di memori disegarkan dari Redis.
   *
   * Boleh panjang. Katalog adalah data STATIS: nama, alamat, koordinat. Yang
   * tidak boleh basi adalah harga, dan harga tidak pernah masuk ke katalog.
   */
  CATALOG_REFRESH_SECONDS: z.coerce.number().int().positive().default(300),

  /** TTL salinan katalog di Redis. Lebih panjang dari selang penyegaran. */
  CATALOG_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(3_600),

  /**
   * Seberapa sering kemunculan properti belum terpetakan disiram ke basis
   * data. Pencatatan tidak pernah ditunggu permintaan pencarian.
   */
  UNMAPPED_FLUSH_SECONDS: z.coerce.number().int().positive().default(30),

  SUGGESTION_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(600),

  /**
   * Anggaran waktu total fan-out ke seluruh supplier.
   *
   * 1200ms adalah titik awal, bukan hasil pengukuran. LUNA menjawab sekitar
   * 3 detik; anggaran ini memastikan pencarian tidak pernah menunggunya, dan
   * jawabannya tetap dipanen untuk pencarian berikutnya. Step 15 yang
   * menyetelnya berdasarkan uji beban.
   */
  SEARCH_BUDGET_MS: z.coerce.number().int().positive().max(10_000).default(1_200),

  /**
   * Batas waktu per panggilan ke supplier-service.
   *
   * Lebih panjang dari anggaran dengan sengaja: yang memutuskan kapan berhenti
   * menunggu adalah anggaran, dan panggilan yang berlanjut setelahnya justru
   * yang hasilnya dipanen ke cache lapis kedua.
   */
  SUPPLIER_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  PRICING_TIMEOUT_MS: z.coerce.number().int().positive().default(3_000),

  SUPPLIER_SERVICE_URL: z.string().min(1).default('http://localhost:4004'),
  PRICING_SERVICE_URL: z.string().min(1).default('http://localhost:4005'),

  /** TTL cache hasil gabungan. Pendek: harga berubah, dan harga basi merugikan. */
  SEARCH_RESULT_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  /** TTL cache per supplier. Sedikit lebih panjang — lihat redis-search-cache.ts. */
  SEARCH_SUPPLIER_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  /** Masa berlaku kunci anti-stampede. Cukup untuk satu fan-out, tidak lebih. */
  SEARCH_LOCK_TTL_SECONDS: z.coerce.number().int().positive().default(10),

  KAFKA_BROKERS: z.string().default('localhost:9092'),

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
