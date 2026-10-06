import { randomUUID } from 'node:crypto'
import { createKafkaClient } from '@tbe/messaging'
import { waitFor } from './waits.js'

/**
 * Pengamat Kafka SUNGGUHAN: membaca apa yang benar-benar sampai di topik,
 * bukan apa yang dikira dikirim, dan menyimpan pesan MENTAHNYA supaya uji
 * dapat menerbitkannya ulang byte demi byte (skenario "peristiwa dikirim
 * ulang").
 */

export interface RawMessage {
  readonly topic: string
  readonly key: Buffer | null
  readonly value: Buffer
  readonly headers: Readonly<Record<string, Buffer>>
}

export interface ObservedEvent {
  readonly type: string
  readonly eventId: string
  readonly bookingId: string | undefined
  readonly payload: Readonly<Record<string, unknown>>
  readonly raw: RawMessage
}

export interface KafkaWatch {
  readonly seen: readonly ObservedEvent[]
  waitForEvent(type: string, bookingId: string, timeoutMs?: number): Promise<ObservedEvent>
  /** Menerbitkan ulang pesan yang sama persis — kunci, isi, dan header. */
  republish(raw: RawMessage): Promise<void>
  stop(): Promise<void>
}

export async function watchKafka(
  brokers: readonly string[],
  topics: readonly string[],
): Promise<KafkaWatch> {
  const kafka = createKafkaClient({ clientId: 'saga-it-watch', brokers: [...brokers] })
  const consumer = kafka.consumer({ groupId: `saga-it-watch-${randomUUID()}` })
  const producer = kafka.producer()
  const seen: ObservedEvent[] = []

  await Promise.all([consumer.connect(), producer.connect()])
  await consumer.subscribe({ topics: [...topics], fromBeginning: true })
  await consumer.run({
    eachMessage: async ({ topic, message }) => {
      if (message.value !== null) {
        const raw: RawMessage = {
          topic,
          key: message.key,
          value: message.value,
          headers: headersOf(message.headers),
        }
        const parsed = parse(raw)
        if (parsed !== undefined) seen.push(parsed)
      }
      await Promise.resolve()
    },
  })

  return {
    seen,
    async waitForEvent(type, bookingId, timeoutMs = 60_000) {
      return await waitFor(
        `peristiwa ${type} untuk ${bookingId} di Kafka`,
        async () => await Promise.resolve(find(seen, type, bookingId)),
        (found) => found !== undefined,
        timeoutMs,
      ).then((found) => {
        if (found === undefined) throw new Error('mustahil: waitFor menerima undefined')
        return found
      })
    },
    async republish(raw) {
      await producer.send({
        topic: raw.topic,
        messages: [{ key: raw.key, value: raw.value, headers: { ...raw.headers } }],
      })
    },
    async stop() {
      await Promise.allSettled([consumer.disconnect(), producer.disconnect()])
    },
  }
}

function find(seen: readonly ObservedEvent[], type: string, bookingId: string) {
  return seen.find((event) => event.type === type && event.bookingId === bookingId)
}

function headersOf(headers: Record<string, unknown> | undefined): Record<string, Buffer> {
  if (headers === undefined) return {}
  const entries: [string, Buffer][] = []
  for (const [name, value] of Object.entries(headers)) {
    if (Buffer.isBuffer(value)) entries.push([name, value])
    else if (typeof value === 'string') entries.push([name, Buffer.from(value)])
  }
  return Object.fromEntries(entries)
}

function parse(raw: RawMessage): ObservedEvent | undefined {
  const value: unknown = JSON.parse(raw.value.toString('utf8'))
  if (typeof value !== 'object' || value === null) return undefined
  if (!('eventType' in value) || !('eventId' in value) || !('payload' in value)) return undefined
  const payload = value.payload
  if (typeof payload !== 'object' || payload === null) return undefined
  const record = Object.fromEntries(Object.entries(payload))

  return {
    type: String(value.eventType),
    eventId: String(value.eventId),
    bookingId: typeof record.bookingId === 'string' ? record.bookingId : undefined,
    payload: record,
    raw,
  }
}
