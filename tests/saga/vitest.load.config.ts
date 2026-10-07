import { defineConfig } from 'vitest/config'

/**
 * Uji beban konkurensi pemesanan (Step 22).
 *
 * Global setup yang SAMA dengan uji saga: Testcontainers, migrasi, seed,
 * topik, dan mock-supplier sebagai kontainer. Jalankan SATU skenario per jalan
 * (`pnpm loadtest:booking <skenario>`): pemeriksaan sesudahnya membaca seluruh
 * tabel, dan dua skenario di basis data yang sama saling mencemari angkanya.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['load/**/*.load.ts'],
    globalSetup: ['harness/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 1_800_000,
    hookTimeout: 600_000,
  },
})
