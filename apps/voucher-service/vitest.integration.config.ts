import { defineConfig } from 'vitest/config'

/**
 * Uji integrasi: Postgres dan MinIO SUNGGUHAN lewat Testcontainers
 * (CONVENTIONS.md bagian 10).
 *
 * Yang dibuktikan di sini tidak dapat dibuktikan palsuan mana pun: batasan
 * UNIK booking_id di migrasi, dan URL bertanda tangan MinIO yang benar-benar
 * dapat dibuka — lalu berhenti berlaku. Tanpa Docker uji GAGAL keras, tidak
 * dilewati.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
})
