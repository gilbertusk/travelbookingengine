import { EVENT_TYPES, type EventType } from './events.js'

/**
 * Topik Kafka beserta jumlah partisi dan kunci partisinya.
 *
 * Dua hal yang menentukan, dan keduanya dijawab per topik di bawah:
 *
 * 1. **Kunci partisi menentukan urutan.** Kafka hanya menjamin urutan di dalam
 *    satu partisi. Seluruh peristiwa satu pemesanan harus berkunci bookingId,
 *    kalau tidak `booking.confirmed` bisa tiba sebelum `booking.created` dan
 *    saga membaca keadaan yang belum ada.
 * 2. **Jumlah partisi membatasi paralelisme.** Consumer aktif dalam satu group
 *    tidak pernah melebihi jumlah partisi.
 */

export type PartitionKeySource = 'bookingId' | 'supplier' | 'city'

export interface TopicDefinition {
  readonly name: string
  readonly partitions: number
  readonly partitionKey: PartitionKeySource
  readonly retentionMs: number
  readonly events: readonly EventType[]
  readonly rationale: string
}

const DAY_MS = 86_400_000

export const DEAD_LETTER_TOPIC = 'tbe.dead-letter.v1'

export const TOPICS: readonly TopicDefinition[] = [
  {
    name: 'tbe.booking.v1',
    partitions: 6,
    partitionKey: 'bookingId',
    retentionMs: 90 * DAY_MS,
    events: [
      'booking.created',
      'booking.held',
      'booking.price_changed',
      'booking.confirmed',
      'booking.failed',
      'booking.cancelled',
    ],
    rationale:
      'Urutan per pemesanan wajib terjaga, jadi dikunci bookingId. Retensi panjang ' +
      'karena Step 27 harus dapat membangun ulang agregat dari awal topik.',
  },
  {
    name: 'tbe.payment.v1',
    partitions: 6,
    partitionKey: 'bookingId',
    retentionMs: 90 * DAY_MS,
    events: ['payment.succeeded', 'payment.failed', 'payment.refunded'],
    rationale:
      'Dikunci bookingId agar seluruh peristiwa pembayaran satu pemesanan tiba ' +
      'berurutan pada consumer yang sama. Retensi panjang untuk audit finansial.',
  },
  {
    name: 'tbe.supplier-booking.v1',
    partitions: 6,
    partitionKey: 'bookingId',
    retentionMs: 90 * DAY_MS,
    events: [
      'supplier.booking_confirmed',
      'supplier.booking_rejected',
      'supplier.booking_uncertain',
    ],
    rationale:
      'Hasil supplier.confirm untuk saga (Step 19). Dikunci bookingId, bukan kode ' +
      'supplier: urutan yang penting adalah urutan per pemesanan, dan satu supplier ' +
      'populer tidak boleh memusatkan seluruh saga di satu partisi. Terpisah dari ' +
      'tbe.supplier.v1 karena yang itu satu partisi dan beretensi pendek; ' +
      'jawaban supplier atas pemesanan berbayar adalah catatan finansial.',
  },
  {
    name: 'tbe.search.v1',
    partitions: 3,
    partitionKey: 'city',
    retentionMs: 7 * DAY_MS,
    events: ['search.performed'],
    rationale:
      'Hanya dibaca analitik, urutan antar pencarian tidak penting. Dikunci kota ' +
      'agar agregasi per kota terkumpul di satu partisi. Retensi pendek.',
  },
  {
    name: 'tbe.supplier.v1',
    partitions: 1,
    partitionKey: 'supplier',
    retentionMs: 7 * DAY_MS,
    events: ['supplier.degraded', 'supplier.recovered'],
    rationale:
      'Volume sangat rendah dan urutan degraded/recovered per supplier wajib ' +
      'terjaga. Satu partisi sudah cukup dan paling sederhana.',
  },
]

const TOPIC_BY_EVENT = new Map<EventType, TopicDefinition>(
  TOPICS.flatMap((topic) => topic.events.map((event) => [event, topic] as const)),
)

export function topicFor(event: EventType): TopicDefinition {
  const topic = TOPIC_BY_EVENT.get(event)

  if (topic === undefined) {
    throw new Error(`Peristiwa "${event}" belum dipetakan ke topik mana pun`)
  }

  return topic
}

/** Peristiwa yang belum punya topik. Diperiksa oleh pengujian, bukan saat jalan. */
export function unmappedEvents(): readonly EventType[] {
  return EVENT_TYPES.filter((event) => !TOPIC_BY_EVENT.has(event))
}
