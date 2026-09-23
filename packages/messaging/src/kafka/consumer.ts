import {
  DEAD_LETTER_TOPIC,
  EVENT_SCHEMAS,
  isEventType,
  type EventPayload,
  type EventType,
  type Message,
} from '@tbe/event-contracts'
import { runWithCorrelation, type Logger } from '@tbe/shared-kernel'
import type { IncomingEvent, KafkaProducerPort } from '../ports.js'

/**
 * Pembungkus consumer peristiwa.
 *
 * Aturan commit offset ditentukan oleh apa yang dilempar fungsi ini:
 *
 * - Selesai tanpa melempar  -> offset ter-commit, pesan dianggap selesai
 * - Melempar                -> offset TIDAK ter-commit, pesan dibaca lagi
 *
 * Karena itu pesan cacat tidak boleh dilempar. Melemparnya membuat partisi
 * berhenti selamanya pada pesan yang tidak akan pernah bisa diproses — seluruh
 * pemesanan di partisi itu ikut berhenti. Pesan cacat dikirim ke dead letter
 * lalu dianggap selesai.
 */

export interface EventHandlerOptions {
  readonly subscribedTo: readonly EventType[]
  readonly producer: KafkaProducerPort
  readonly logger: Logger
  handle(message: Message<EventType, EventPayload<EventType>>): Promise<void>
}

export type EventConsumer = (incoming: IncomingEvent) => Promise<void>

export function createEventConsumer(options: EventHandlerOptions): EventConsumer {
  const subscribed = new Set<string>(options.subscribedTo)

  return async (incoming) => {
    const message = parseEvent(incoming)

    if (message === undefined) {
      await deadLetter(options, incoming, 'tidak sesuai kontrak')
      return
    }

    if (!subscribed.has(message.eventType)) {
      // Topik membawa beberapa jenis peristiwa; yang tidak diminta dilewati
      // tanpa suara. Ini bukan kesalahan.
      return
    }

    await runWithCorrelation(message.correlationId, async () => {
      await options.handle(message)
    })
  }
}

function parseEvent(
  incoming: IncomingEvent,
): Message<EventType, EventPayload<EventType>> | undefined {
  if (incoming.value === null) return undefined

  try {
    const raw: unknown = JSON.parse(incoming.value.toString('utf8'))
    const type = typeOf(raw)
    if (type === undefined) return undefined

    const parsed = EVENT_SCHEMAS[type].safeParse(raw)
    return parsed.success ? (parsed.data as Message<EventType, EventPayload<EventType>>) : undefined
  } catch {
    return undefined
  }
}

function typeOf(raw: unknown): EventType | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined

  const candidate = (raw as Record<string, unknown>).eventType
  return typeof candidate === 'string' && isEventType(candidate) ? candidate : undefined
}

async function deadLetter(
  options: EventHandlerOptions,
  incoming: IncomingEvent,
  reason: string,
): Promise<void> {
  options.logger.error(
    { topic: incoming.topic, partition: incoming.partition, reason },
    'peristiwa cacat dikirim ke dead letter',
  )

  await options.producer.send(DEAD_LETTER_TOPIC, [
    {
      key: `${incoming.topic}:${String(incoming.partition)}`,
      value: incoming.value === null ? '' : incoming.value.toString('utf8'),
      headers: { 'x-origin-topic': incoming.topic, 'x-reason': reason },
    },
  ])
}
