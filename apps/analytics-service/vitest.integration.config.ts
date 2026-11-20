import { defineConfig } from 'vitest/config'

/**
 * Uji integrasi: Postgres dan Kafka SUNGGUHAN (CONVENTIONS.md bagian 10).
 *
 * Dari env `INTEGRATION_DATABASE_URL` dan `INTEGRATION_KAFKA_BROKERS` bila
 * keduanya diisi, selain itu Testcontainers. Tanpa keduanya DAN tanpa Docker,
 * global setup melempar dan uji GAGAL keras — tidak dilewati.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    globalSetup: ['tests/integration/global-setup.ts'],
    fileParallelism: false,
    // Replay memutar enam topik lewat `admin.resetOffsets`, masing-masing
    // beberapa detik (lihat infrastructure/kafka-offsets.ts).
    testTimeout: 300_000,
    hookTimeout: 180_000,
  },
})
