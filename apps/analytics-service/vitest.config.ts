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
        // Adapter Prisma dan admin Kafka diuji terhadap Postgres dan Kafka
        // SUNGGUHAN di tests/integration: penambahan atomik ON CONFLICT,
        // deduplikasi oleh kunci primer, dan pemutaran offset consumer group
        // tidak dapat dibuktikan palsuan mana pun.
        'src/infrastructure/prisma-*.ts',
        'src/infrastructure/kafka-*.ts',
        'src/infrastructure/system.ts',
        // Perangkaian consumer dan skrip replay: diuji lewat uji integrasi,
        // yang memakai `analyticsConsumer` yang sama dengan index.ts.
        'src/composition/consumer.ts',
        'src/composition/replay-main.ts',
        'src/generated/**',
        'src/testing/**',
      ],
      reporter: ['text', 'json-summary'],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 85,
        statements: 85,
        // Domain: 95% — kebijakan proyek untuk logika murni.
        'src/domain/**': { lines: 95, functions: 95, branches: 95, statements: 95 },
      },
    },
  },
})
