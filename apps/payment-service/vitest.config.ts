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
        // menguji pemetaan ORM dengan tiruan hanya menguji tiruannya. Yang
        // diuji di sini adalah KEPUTUSAN idempotensinya, dan keputusan itu
        // hidup di application terhadap port — lihat testing/fakes.ts, yang
        // meniru batasan UNIK alih-alih sekadar mencatat panggilan.
        'src/infrastructure/prisma-*.ts',
        'src/infrastructure/kafka-*.ts',
        // Adapter Midtrans: satu pemanggilan HTTP dan satu penguraian respons.
        // Sandbox tidak dapat diperintah gagal sesuai kehendak, jadi yang
        // diuji adalah port-nya (Step 28 menyuntikkan kegagalan di sana).
        'src/infrastructure/midtrans-gateway.ts',
        // Jembatan tipis ke pustaka luar: rate-limiter-flexible, Date.now,
        // dan crypto.randomUUID. Mengujinya berarti menguji pustakanya.
        'src/infrastructure/rate-limiters.ts',
        'src/infrastructure/system.ts',
        'src/generated/**',
        'src/testing/**',
        'src/composition/**',
      ],
      reporter: ['text', 'json-summary'],
      thresholds: { lines: 85, functions: 85, branches: 85, statements: 85 },
    },
  },
})
