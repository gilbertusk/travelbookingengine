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
        // Adapter Prisma diuji terhadap Postgres sungguhan di tests/integration,
        // bukan dengan tiruan: batasan UNIK dedupe_key dan FOR UPDATE SKIP
        // LOCKED tidak dapat dibuktikan palsuan mana pun. Keputusan
        // deduplikasinya diuji terhadap port lewat testing/fakes.ts, yang
        // meniru batasan itu alih-alih mencatat panggilan.
        'src/infrastructure/prisma-*.ts',
        'src/generated/**',
        'src/testing/**',
      ],
      reporter: ['text', 'json-summary'],
      thresholds: { lines: 85, functions: 85, branches: 85, statements: 85 },
    },
  },
})
