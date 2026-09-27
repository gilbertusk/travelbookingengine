import { defineConfig } from 'vitest/config'

/**
 * Uji integrasi: Redis dan Postgres SUNGGUHAN, bukan palsuan.
 *
 * Yang dibuktikan di sini adalah sifat infrastruktur yang diandalkan kode dan
 * yang tidak dapat dibuktikan palsuan mana pun: atomisitas skrip Lua,
 * keyspace notification, batasan UNIK dan transaksi Postgres, trigger dan
 * CHECK di migrasi, dan perilaku adapter-pg terhadap kolom DATE.
 *
 * CONVENTIONS.md bagian 10 meminta Testcontainers. Docker tidak tersedia,
 * jadi infrastrukturnya diberikan lewat env — `INTEGRATION_DATABASE_URL` dan
 * `INTEGRATION_REDIS_URL` — dan uji GAGAL keras bila salah satunya tidak ada.
 * Tidak dilewati: uji integrasi yang diam-diam tidak berjalan adalah persis
 * bentuk "hijau" yang tidak membuktikan apa pun.
 *
 * Zona waktu dapat diganti lewat `INTEGRATION_TZ` supaya uji kolom DATE dapat
 * dijalankan di zona di depan dan di belakang UTC.
 */
process.env.TZ = process.env.INTEGRATION_TZ ?? 'Asia/Jakarta'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    globalSetup: ['tests/integration/global-setup.ts'],
    // Satu berkas pada satu waktu: seluruhnya berbagi satu basis data dan
    // satu Redis, dan uji balapan di dalamnya tidak boleh ikut berebut dengan
    // uji di berkas lain.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
