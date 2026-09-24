import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/index.ts',
        'src/config.ts',
        'src/telemetry.ts',
        // Adapter Prisma diuji lewat uji integrasi pada Step 20, bukan unit:
        // menguji pemetaan ORM dengan tiruan hanya menguji tiruannya.
        'src/infrastructure/prisma-*.ts',
        // Adapter Redis sama halnya: yang diuji di sini adalah keputusannya,
        // yang hidup di domain dan tidak menyentuh Redis sama sekali.
        'src/infrastructure/redis-*.ts',
        'src/infrastructure/kafka-*.ts',
        'src/infrastructure/runtime.ts',
        // Jembatan tipis ke pustaka luar: satu memanggil prom-client, satu
        // memanggil Date.now dan setTimeout. Mengujinya berarti menguji
        // pustakanya, bukan keputusan kita.
        'src/infrastructure/prom-metrics.ts',
        'src/infrastructure/system.ts',
        'src/generated/**',
        'src/testing/**',
        'src/composition/**',
      ],
      reporter: ['text', 'json-summary'],
      thresholds: { lines: 85, functions: 85, branches: 80, statements: 85 },
    },
  },
})
