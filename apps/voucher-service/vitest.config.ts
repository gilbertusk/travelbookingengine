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
        // Adapter Prisma dan MinIO diuji terhadap Postgres dan MinIO sungguhan
        // di tests/integration, bukan dengan tiruan: menguji pemetaan ORM atau
        // klien S3 dengan tiruan hanya menguji tiruannya. Keputusan
        // idempotensinya hidup di application, diuji terhadap port — lihat
        // testing/fakes.ts, yang meniru batasan UNIK alih-alih mencatat panggilan.
        'src/infrastructure/prisma-*.ts',
        'src/infrastructure/minio-storage.ts',
        'src/infrastructure/kafka-*.ts',
        'src/generated/**',
        'src/testing/**',
      ],
      reporter: ['text', 'json-summary'],
      thresholds: { lines: 85, functions: 85, branches: 85, statements: 85 },
    },
  },
})
