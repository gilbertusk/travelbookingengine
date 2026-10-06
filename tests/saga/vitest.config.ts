import { defineConfig } from 'vitest/config'

/**
 * Rangkaian uji saga lintas service (Step 20) — NFR-19, M9.
 *
 * Satu berkas pada satu waktu, dan uji di dalamnya berurutan: seluruh
 * skenario berbagi SATU mock-supplier (panel kendali kegagalannya global per
 * supplier) dan satu set broker. Dua skenario yang menyuntikkan kegagalan
 * bersamaan akan saling menyabotase, dan uji yang lulus karena kebetulan
 * urutan adalah uji yang tidak membuktikan apa pun.
 *
 * Batas waktunya besar dengan sengaja. Skenario refund menunggu jenjang retry
 * RabbitMQ yang SUNGGUHAN (5 s, 30 s, 2 m) sampai dead letter — memendekkannya
 * khusus untuk uji berarti menguji topologi yang berbeda dari produksi.
 * Setiap penantian di dalam uji tetap polling dengan batas waktunya sendiri
 * (harness/waits.ts), jadi batas di sini hanyalah jaring pengaman.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['scenarios/**/*.test.ts'],
    globalSetup: ['harness/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 480_000,
    // Global setup membangun citra mock-supplier dan menyalakan empat broker.
    hookTimeout: 600_000,
  },
})
