import { Counter, type Registry } from 'prom-client'
import type { DeliveryMetrics } from '../application/ports.js'

/**
 * Hasil penghantaran per jenis surel.
 *
 * Peringatan dead letter dibaca dari sini:
 * `increase(notification_deliveries_total{outcome="dead"}[15m]) > 0` berarti
 * ada pengguna yang tidak menerima kabar tentang pemesanannya, dan
 * `outcome="failed"` berarti alamatnya ditolak. Keduanya butuh manusia.
 */
export function createDeliveryMetrics(registry: Registry): DeliveryMetrics {
  const counter = new Counter({
    name: 'notification_deliveries_total',
    help: 'Hasil percobaan kirim pemberitahuan, per jenis surel dan hasil',
    labelNames: ['type', 'outcome'] as const,
    registers: [registry],
  })

  return {
    delivered(type, outcome) {
      counter.inc({ type, outcome })
    },
  }
}
