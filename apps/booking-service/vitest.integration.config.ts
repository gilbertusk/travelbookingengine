import { defineConfig } from 'vitest/config'

/**
 * Uji integrasi: Redis dan Postgres SUNGGUHAN, bukan palsuan — dan sejak
 * Step 19, Kafka dan RabbitMQ sungguhan untuk jalur saga
 * (`INTEGRATION_KAFKA_BROKERS`, `INTEGRATION_RABBITMQ_URL`).
 *
 * Yang dibuktikan di sini adalah sifat infrastruktur yang diandalkan kode dan
 * yang tidak dapat dibuktikan palsuan mana pun: atomisitas skrip Lua,
 * keyspace notification, batasan UNIK dan transaksi Postgres, trigger dan
 * CHECK di migrasi, dan perilaku adapter-pg terhadap kolom DATE.
 *
 * Sejak Step 20 infrastrukturnya dinyalakan Testcontainers (CONVENTIONS.md
 * bagian 10), kecuali keempat env `INTEGRATION_*` diisi — lihat
 * tests/integration/env.ts. Tanpa keduanya uji GAGAL keras, tidak dilewati:
 * uji integrasi yang diam-diam tidak berjalan adalah persis bentuk "hijau"
 * yang tidak membuktikan apa pun.
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
    // Uji saga Step 19 menunggu pesan melintasi Kafka dan RabbitMQ sungguhan.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
