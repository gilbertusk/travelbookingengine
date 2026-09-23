import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // tracing.ts adalah perangkaian SDK OpenTelemetry: mengujinya berarti
      // menyalakan SDK sungguhan beserta eksportirnya, yang meninggalkan handle
      // terbuka dan tidak membuktikan apa pun tentang kode kita. Jalur yang
      // memang milik kita — mode nonaktif dan penutupan — tetap diuji.
      exclude: ['src/**/*.test.ts', 'src/index.ts', 'src/observability/tracing.ts'],
      reporter: ['text', 'json-summary'],
      // Seluruh service bergantung pada package ini, jadi ambangnya lebih
      // tinggi daripada 80% yang berlaku umum di CONVENTIONS.md bagian 10.
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 85,
        statements: 90,
      },
    },
  },
})
