import { initTracing, type TracingHandle } from '@tbe/shared-kernel'

/**
 * Inisialisasi penelusuran, dijalankan saat modul ini dimuat dan diimpor paling
 * pertama di index.ts. Lihat catatan Step 06: instrumentasi otomatis menambal
 * pustaka pada saat dimuat, jadi memanggilnya setelah impor lain selalu
 * terlambat.
 */
export const tracingSdk: TracingHandle = initTracing({
  serviceName: process.env.SERVICE_NAME ?? 'notification-service',
  environment: process.env.NODE_ENV ?? 'development',
  otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318/v1/traces',
  enabled: process.env.OTEL_ENABLED !== 'false',
})
