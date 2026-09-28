import {
  createKafkaClient,
  createRabbitConnection,
  mainQueue,
  type RabbitConnection,
} from '@tbe/messaging'
import type { CommandType } from '@tbe/event-contracts'
import { brokerEnv } from './env.js'

/**
 * Pengamat broker SUNGGUHAN untuk uji integrasi Step 19: membaca apa yang
 * benar-benar sampai di Kafka dan RabbitMQ, bukan apa yang dikira dikirim.
 */

export interface Observed {
  readonly type: string
  readonly eventId: string
  readonly occurredAt: string
  readonly payload: Record<string, unknown>
  readonly key?: string | null
}

function parse(raw: string): Observed | undefined {
  const value: unknown = JSON.parse(raw)
  if (typeof value !== 'object' || value === null) return undefined
  if (!('eventType' in value) || !('eventId' in value) || !('payload' in value)) return undefined
  if (!('occurredAt' in value)) return undefined
  const { eventType, eventId, payload, occurredAt } = value
  if (typeof payload !== 'object' || payload === null) return undefined

  return {
    type: String(eventType),
    eventId: String(eventId),
    occurredAt: String(occurredAt),
    payload: Object.fromEntries(Object.entries(payload)),
  }
}

/** Perintah yang sampai di antrian RabbitMQ; setiap pesan di-ack. */
export async function commandObserver(commands: readonly CommandType[]): Promise<{
  readonly seen: Observed[]
  readonly rabbit: RabbitConnection
  stop(): Promise<void>
}> {
  const { rabbitmqUrl } = brokerEnv()
  const rabbit = createRabbitConnection({ url: rabbitmqUrl })
  const seen: Observed[] = []

  for (const command of commands) {
    rabbit.consume(mainQueue(command), 20, async (incoming) => {
      const parsed = parse(incoming.content.toString('utf8'))
      if (parsed !== undefined) seen.push(parsed)
      return await Promise.resolve('ack' as const)
    })
  }
  await rabbit.resource.start?.()

  return {
    seen,
    rabbit,
    stop: async () => {
      await rabbit.resource.stop()
    },
  }
}

/** Peristiwa yang sampai di topik Kafka, dibaca dari AWAL topik dengan group baru. */
export async function eventObserver(topics: readonly string[]): Promise<{
  readonly seen: Observed[]
  stop(): Promise<void>
}> {
  const { kafkaBrokers } = brokerEnv()
  const kafka = createKafkaClient({ clientId: 'booking-it-observer', brokers: kafkaBrokers })
  const consumer = kafka.consumer({ groupId: `booking-it-observer-${String(Date.now())}` })
  const seen: Observed[] = []

  await consumer.connect()
  await consumer.subscribe({ topics: [...topics], fromBeginning: true })
  await consumer.run({
    eachMessage: async ({ message }) => {
      const parsed = message.value === null ? undefined : parse(message.value.toString('utf8'))
      if (parsed !== undefined) seen.push({ ...parsed, key: message.key?.toString('utf8') ?? null })
      await Promise.resolve()
    },
  })

  return {
    seen,
    stop: async () => {
      await consumer.disconnect()
    },
  }
}

/** Menunggu sampai kondisi terpenuhi, atau gagal dengan pesan yang menjelaskan. */
export async function eventually(
  label: string,
  condition: () => Promise<boolean> | boolean,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`tidak pernah terpenuhi dalam ${String(timeoutMs)} ms: ${label}`)
}
