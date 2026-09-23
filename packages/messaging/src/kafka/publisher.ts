import {
  EVENT_SCHEMAS,
  createMessage,
  topicFor,
  type EventPayload,
  type EventType,
  type PartitionKeySource,
} from '@tbe/event-contracts'
import { ValidationError } from '@tbe/shared-kernel'
import type { KafkaProducerPort } from '../ports.js'

/**
 * Penerbit peristiwa.
 *
 * Hanya menerima jenis peristiwa. Tidak ada cara mengirim perintah lewat sini,
 * sama seperti tidak ada cara mengirim peristiwa lewat CommandSender.
 * Pemisahan peran dua perantara pesan ditegakkan oleh bentuk API-nya, bukan
 * oleh dokumentasi yang berharap dibaca.
 */

export interface PublishEventOptions {
  readonly causationId?: string
  readonly traceparent?: string
}

export interface EventPublisher {
  publish<T extends EventType>(
    type: T,
    payload: EventPayload<T>,
    options?: PublishEventOptions,
  ): Promise<void>
}

export function createEventPublisher(producer: KafkaProducerPort): EventPublisher {
  return {
    async publish(type, payload, options) {
      const topic = topicFor(type)
      const message = createMessage({
        eventType: type,
        payload,
        ...(options?.causationId === undefined ? {} : { causationId: options.causationId }),
        ...(options?.traceparent === undefined ? {} : { traceparent: options.traceparent }),
      })

      const parsed = EVENT_SCHEMAS[type].safeParse(message)
      if (!parsed.success) {
        throw new ValidationError(`Peristiwa "${type}" tidak sesuai kontrak`, {
          issues: parsed.error.issues.map((issue) => ({
            field: issue.path.join('.'),
            message: issue.message,
          })),
        })
      }

      await producer.send(topic.name, [
        {
          key: partitionKeyOf(payload, topic.partitionKey),
          value: JSON.stringify(message),
          headers: {
            'x-event-type': type,
            'x-correlation-id': message.correlationId,
            ...(message.traceparent === undefined ? {} : { traceparent: message.traceparent }),
          },
        },
      ])
    },
  }
}

/**
 * Kunci partisi menentukan urutan.
 *
 * Kunci yang hilang berarti Kafka menyebar pesan secara round-robin, dan
 * `booking.confirmed` bisa tiba sebelum `booking.created`. Kegagalan itu tidak
 * bersuara: tidak ada galat, hanya saga yang sesekali membaca keadaan yang
 * belum ada. Karena itu kunci yang hilang dilaporkan sebagai galat di sini.
 */
export function partitionKeyOf(payload: unknown, source: PartitionKeySource): string {
  const value =
    typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>)[source]
      : undefined

  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`Kunci partisi "${source}" tidak ada pada payload`, { source })
  }

  return value
}
