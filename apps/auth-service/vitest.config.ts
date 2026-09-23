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
        'src/generated/**',
        'src/testing/**',
        'src/composition/**',
      ],
      reporter: ['text', 'json-summary'],
      thresholds: { lines: 85, functions: 85, branches: 80, statements: 85 },
    },
  },
})
