import type { EventPublisher } from '@tbe/messaging'
import type { SupplierCode } from '@tbe/supplier-adapters'
import type { SupplierEvents } from '../application/ports.js'

/**
 * Perubahan keadaan pemutus sebagai peristiwa Kafka.
 *
 * Peristiwa, bukan perintah: tidak ada yang diminta melakukan apa pun. Yang
 * disampaikan adalah fakta — supplier ini sedang tidak sehat — dan siapa pun
 * yang peduli boleh mendengarkan. Dasbor operasi mendengarkannya pada Step 27.
 */
export function createKafkaSupplierEvents(publisher: EventPublisher): SupplierEvents {
  return {
    async degraded(supplier: SupplierCode, state: 'open' | 'half_open', reason: string) {
      await publisher.publish('supplier.degraded', { supplier, circuitState: state, reason })
    },

    async recovered(supplier: SupplierCode) {
      await publisher.publish('supplier.recovered', { supplier })
    },
  }
}
