import { initTracing, type TracingHandle } from '@tbe/shared-kernel'

/** Harus dimuat paling pertama — lihat catatan Step 06. */
export const tracingSdk: TracingHandle = initTracing({
  serviceName: process.env.SERVICE_NAME ?? 'api-gateway',
  environment: process.env.NODE_ENV ?? 'development',
  otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318/v1/traces',
  enabled: process.env.OTEL_ENABLED !== 'false',
})
