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
        'src/testing.ts',
        'src/**/client.ts',
        'src/bin/**',
        // Hanya berbicara dengan admin Kafka sungguhan. Dijalankan setiap kali
        // uji integrasi Step 20 menyalakan broker; uji unit dengan admin
        // palsuan hanya akan membuktikan palsuannya.
        'src/kafka/topics.ts',
      ],
      reporter: ['text', 'json-summary'],
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
    },
  },
})
