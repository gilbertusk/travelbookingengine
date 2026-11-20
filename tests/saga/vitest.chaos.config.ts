import { defineConfig } from 'vitest/config'

/**
 * Rangkaian chaos (Step 28) — `pnpm chaos:run` dari akar repositori.
 *
 * Terpisah dari uji saga Step 20 karena dua hal: ia menyalakan Jaeger untuk
 * trace pemulihan, dan durasinya — kegagalan yang berlangsung 30 detik,
 * webhook yang terlambat lima menit — tidak layak dibayar setiap PR. Berjalan
 * di workflow `chaos` (CI), dan dari mesin dengan Docker.
 *
 * Satu berkas pada satu waktu, uji di dalamnya berurutan: setiap skenario
 * mematikan sesuatu yang dipakai bersama — kontainer broker, basis data,
 * mock-supplier — dan dua skenario serentak saling menyabotase.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['chaos/**/*.chaos.test.ts'],
    globalSetup: ['chaos/global-setup.ts'],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 900_000,
    hookTimeout: 600_000,
  },
})
