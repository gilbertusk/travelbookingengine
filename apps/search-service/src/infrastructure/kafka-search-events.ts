import type { EventPublisher } from '@tbe/messaging'
import type { SearchEvents, SearchPerformedPayload } from '../application/ports.js'

/**
 * Pencarian sebagai peristiwa Kafka.
 *
 * Peristiwa, bukan perintah: tidak ada yang diminta melakukan apa pun. Yang
 * disampaikan adalah fakta — pencarian ini terjadi, sekian hasilnya, sekian
 * lama — dan analitik pada Step 26 yang mendengarkannya.
 *
 * TIDAK ada data pribadi: tidak ada userId, tidak ada alamat surel, tidak ada
 * alamat IP. Topiknya beretensi pendek dan dibaca banyak pihak, dan tidak ada
 * satu pun pertanyaan analitik yang membutuhkan tahu SIAPA yang mencari.
 * Larangan ini ditegakkan bentuk payload di @tbe/event-contracts.
 */
export function createKafkaSearchEvents(publisher: EventPublisher): SearchEvents {
  return {
    async performed(payload: SearchPerformedPayload) {
      await publisher.publish('search.performed', {
        city: payload.city,
        checkIn: payload.checkIn,
        checkOut: payload.checkOut,
        guests: payload.guests,
        resultCount: payload.resultCount,
        latencyMs: payload.latencyMs,
        source: payload.source,
        suppliersResponded: [...payload.suppliersResponded],
        suppliersTimedOut: [...payload.suppliersTimedOut],
        suppliersUnavailable: [...payload.suppliersUnavailable],
      })
    },
  }
}
