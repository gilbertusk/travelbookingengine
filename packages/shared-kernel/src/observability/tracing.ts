import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { NodeSDK } from '@opentelemetry/sdk-node'
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
} from '@opentelemetry/semantic-conventions/incubating'
import type { ManagedResource } from '../lifecycle/lifecycle.js'

/**
 * Penelusuran terdistribusi.
 *
 * Dipanggil paling awal di index.ts, sebelum modul lain diimpor — instrumentasi
 * otomatis bekerja dengan menambal pustaka saat dimuat, dan pustaka yang sudah
 * terlanjur dimuat tidak akan ikut terinstrumentasi.
 *
 * Yang membuat ini berharga bukan grafik latensi, melainkan kemampuan melihat
 * satu permintaan pemesanan melintasi gateway, search, lima adapter supplier,
 * lalu masuk ke saga asinkron — dalam satu gambar.
 */

export interface TracingOptions {
  readonly serviceName: string
  readonly serviceVersion?: string | undefined
  readonly environment?: string | undefined
  readonly otlpEndpoint?: string | undefined
  /** Dimatikan pada pengujian; instrumentasi tidak memberi apa pun di sana. */
  readonly enabled?: boolean | undefined
}

const DEFAULT_OTLP_ENDPOINT = 'http://localhost:4318/v1/traces'

/**
 * Pegangan ke SDK yang sedang berjalan. Diberi nama sendiri agar service
 * dapat menuliskan tipenya tanpa mengimpor NodeSDK — tipe yang hanya dapat
 * dirujuk lewat jalur node_modules paket lain tidak portabel.
 */
export type TracingHandle = NodeSDK | undefined

export function initTracing(options: TracingOptions): TracingHandle {
  if (options.enabled === false) return undefined

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.serviceName,
      [ATTR_SERVICE_VERSION]: options.serviceVersion ?? '0.0.0',
      [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: options.environment ?? 'development',
    }),
    traceExporter: new OTLPTraceExporter({
      url: options.otlpEndpoint ?? DEFAULT_OTLP_ENDPOINT,
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // Instrumentasi berkas mencatat setiap pembacaan berkas. Volumenya
        // besar, dan tidak satu pun berguna untuk menelusuri pemesanan.
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-http': {
          // Health check dipanggil terus-menerus oleh orkestrator; menelusurinya
          // hanya menenggelamkan trace yang berguna.
          ignoreIncomingRequestHook: (request) =>
            request.url?.startsWith('/health') === true ||
            request.url?.startsWith('/metrics') === true,
        },
      }),
    ],
  })

  sdk.start()
  return sdk
}

/**
 * Penutupan SDK sebagai sumber daya terkelola.
 *
 * Ditutup paling akhir supaya span dari penutupan sumber daya lain sempat
 * terkirim. Proses yang mati sebelum eksportir menyiram antriannya kehilangan
 * justru span yang paling menarik — span dari saat sistem sedang bermasalah.
 */
export function tracingResource(sdk: TracingHandle): ManagedResource {
  return {
    name: 'tracing',
    stop: async () => {
      await sdk?.shutdown()
    },
  }
}
