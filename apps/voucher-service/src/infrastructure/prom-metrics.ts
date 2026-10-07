import { Histogram, type Registry } from 'prom-client'
import type { IssueMetrics } from '../application/ports.js'

/**
 * Metrik M7: selisih dari konfirmasi pemesanan sampai voucher terbit.
 *
 * Target M7 adalah p95 di bawah 30 detik, jadi bucket dipadatkan di sekitar
 * angka itu — dan bucket 5 dan 35 detik sengaja ada: 5 detik adalah jenjang
 * tunda pertama RabbitMQ (perintah yang gagal sekali), 35 detik adalah
 * "jenjang kedua sudah terpakai", yang berarti M7 terlewati.
 *
 * p95 dibaca dengan `histogram_quantile(0.95, sum by (le)
 * (rate(voucher_issue_latency_seconds_bucket[5m])))`.
 */
export const ISSUE_LATENCY_BUCKETS = [0.5, 1, 2, 5, 10, 20, 30, 35, 60, 150]

export function createIssueMetrics(registry: Registry): IssueMetrics {
  const histogram = new Histogram({
    name: 'voucher_issue_latency_seconds',
    help: 'Selisih waktu dari booking.confirmed sampai voucher terbit (M7)',
    buckets: ISSUE_LATENCY_BUCKETS,
    registers: [registry],
  })

  return {
    observeIssueLatency(seconds) {
      histogram.observe(seconds)
    },
  }
}
