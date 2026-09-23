import type { RequestHandler } from 'express'
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client'

/**
 * Metrik Prometheus.
 *
 * Metrik domain didaftarkan di sini, bukan di service yang memakainya. Alasannya
 * bukan kerapian: nama dan label metrik adalah kontrak dengan dasbor dan alert,
 * dan kontrak yang tersebar di sepuluh service akan berbeda-beda ejaannya dalam
 * hitungan minggu.
 */

export interface MetricsOptions {
  readonly serviceName: string
}

export interface DomainMetrics {
  /** Latensi permintaan ke supplier. Dasar seluruh klaim performa di Step 15. */
  readonly supplierRequestDuration: Histogram<'supplier' | 'operation' | 'outcome'>
  /** 0 tertutup, 1 setengah terbuka, 2 terbuka. */
  readonly supplierCircuitState: Gauge<'supplier'>
  readonly supplierRetries: Counter<'supplier' | 'operation'>
  readonly searchCacheHits: Counter<'layer'>
  readonly searchCacheMisses: Counter<'layer'>
  readonly bookingSagaSteps: Counter<'step' | 'outcome'>
  readonly httpRequestDuration: Histogram<'method' | 'route' | 'status'>
}

export interface Metrics {
  readonly registry: Registry
  readonly domain: DomainMetrics
}

export const CIRCUIT_STATE_VALUES = { closed: 0, half_open: 1, open: 2 } as const

export function createMetrics(options: MetricsOptions): Metrics {
  const registry = new Registry()
  registry.setDefaultLabels({ service: options.serviceName })
  collectDefaultMetrics({ register: registry })

  return { registry, domain: createDomainMetrics(registry) }
}

function createDomainMetrics(registers: Registry): DomainMetrics {
  return {
    supplierRequestDuration: new Histogram({
      name: 'supplier_request_duration_seconds',
      help: 'Durasi permintaan ke supplier',
      labelNames: ['supplier', 'operation', 'outcome'],
      // Bucket dipilih dari profil latensi supplier tiruan: SKY ~0,2s sampai
      // LUNA ~3s. Bucket bawaan prom-client berhenti di 10s dan terlalu kasar
      // untuk membedakan 0,2s dari 0,8s — padahal itu justru yang diukur M1.
      buckets: [0.05, 0.1, 0.2, 0.4, 0.8, 1.2, 2, 3, 5, 10],
      registers: [registers],
    }),

    supplierCircuitState: new Gauge({
      name: 'supplier_circuit_state',
      help: 'Keadaan pemutus sirkuit: 0 tertutup, 1 setengah terbuka, 2 terbuka',
      labelNames: ['supplier'],
      registers: [registers],
    }),

    supplierRetries: new Counter({
      name: 'supplier_retry_total',
      help: 'Jumlah percobaan ulang ke supplier',
      labelNames: ['supplier', 'operation'],
      registers: [registers],
    }),

    searchCacheHits: new Counter({
      name: 'search_cache_hits_total',
      help: 'Jumlah pencarian yang dilayani dari cache',
      labelNames: ['layer'],
      registers: [registers],
    }),

    searchCacheMisses: new Counter({
      name: 'search_cache_misses_total',
      help: 'Jumlah pencarian yang tidak ada di cache',
      labelNames: ['layer'],
      registers: [registers],
    }),

    bookingSagaSteps: new Counter({
      name: 'booking_saga_step_total',
      help: 'Hasil setiap langkah saga pemesanan',
      labelNames: ['step', 'outcome'],
      registers: [registers],
    }),

    httpRequestDuration: new Histogram({
      name: 'http_request_duration_seconds',
      help: 'Durasi permintaan HTTP masuk',
      labelNames: ['method', 'route', 'status'],
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [registers],
    }),
  }
}

export function metricsHandler(registry: Registry): RequestHandler {
  return (_req, res) => {
    void registry.metrics().then(
      (body) => {
        res.setHeader('content-type', registry.contentType)
        res.send(body)
      },
      () => {
        // Kegagalan mengumpulkan metrik tidak boleh mengembalikan 200 dengan
        // badan kosong — Prometheus akan mencatatnya sebagai scrape berhasil
        // dengan nol metrik, dan grafiknya turun ke nol tanpa alasan terlihat.
        res.status(503).end()
      },
    )
  }
}

/**
 * Mengukur satu operasi dan mencatat hasilnya sebagai label outcome.
 *
 * Mencatat durasi tanpa membedakan berhasil dan gagal membuat p95 menyesatkan:
 * permintaan yang gagal cepat menarik angka ke bawah, dan sistem terlihat lebih
 * sehat justru ketika sedang banyak gagal.
 */
export async function observeDuration<T>(
  histogram: Histogram,
  labels: Readonly<Record<string, string>>,
  fn: () => Promise<T>,
): Promise<T> {
  const stop = histogram.startTimer()

  try {
    const result = await fn()
    stop({ ...labels, outcome: labels.outcome ?? 'success' })
    return result
  } catch (error) {
    stop({ ...labels, outcome: 'failure' })
    throw error
  }
}
