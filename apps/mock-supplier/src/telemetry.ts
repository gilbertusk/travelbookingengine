import { initTracing, type TracingHandle } from '@tbe/shared-kernel'

/**
 * Inisialisasi penelusuran, dijalankan saat modul ini dimuat.
 *
 * Diimpor paling pertama di index.ts, sebelum modul lain. Instrumentasi
 * otomatis bekerja dengan menambal pustaka pada saat dimuat, dan pustaka yang
 * sudah terlanjur dimuat tidak akan ikut terinstrumentasi — memanggil
 * initTracing di tengah index.ts terlambat, karena impor ESM dijalankan
 * sebelum satu pun baris badan modul.
 *
 * Env dibaca langsung di sini, bukan lewat config.ts, karena config.ts sendiri
 * belum boleh dimuat pada titik ini.
 */

const enabled = process.env.OTEL_ENABLED !== 'false'

export const tracingSdk: TracingHandle = initTracing({
  serviceName: process.env.SERVICE_NAME ?? 'mock-supplier',
  environment: process.env.NODE_ENV ?? 'development',
  otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318/v1/traces',
  enabled,
})
