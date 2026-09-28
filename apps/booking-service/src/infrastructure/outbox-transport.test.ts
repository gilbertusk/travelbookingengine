import type { CommandSender, EnvelopeOptions, EventPublisher } from '@tbe/messaging'
import { ValidationError } from '@tbe/shared-kernel'
import { describe, expect, test } from 'vitest'
import type { OutboxMessage } from './outbox-relay.js'
import { createMessagingTransport } from './outbox-transport.js'

/**
 * Saluran pesan outbox: peristiwa ke Kafka, perintah ke RabbitMQ — dan tidak
 * pernah sebaliknya, bahkan untuk baris yang salah tercatat.
 */

interface Sent {
  readonly via: 'kafka' | 'rabbitmq'
  readonly type: string
  readonly payload: unknown
  readonly options: EnvelopeOptions | undefined
}

function brokers() {
  const sent: Sent[] = []
  const publisher: EventPublisher = {
    publish: async (type, payload, options) => {
      await Promise.resolve()
      sent.push({ via: 'kafka', type, payload, options })
    },
  }
  const sender: CommandSender = {
    send: async (type, payload, options) => {
      await Promise.resolve()
      sent.push({ via: 'rabbitmq', type, payload, options })
    },
  }
  return { sent, transport: createMessagingTransport(publisher, sender) }
}

const BOOKING = '3f0c8a52-6d1e-4c3b-9a7f-0e1d2c3b4a59'

function message(overrides: Partial<OutboxMessage>): OutboxMessage {
  return {
    id: '0199f000-0000-7000-8000-00000000abcd',
    bookingId: BOOKING,
    channel: 'kafka',
    messageType: 'booking.held',
    payload: { bookingId: BOOKING, holdRef: 'h-1', expiresAt: '2026-10-01T03:15:00.000Z' },
    correlationId: 'req-asal',
    causationId: undefined,
    traceparent: undefined,
    occurredAt: new Date('2026-10-01T03:00:00.000Z'),
    ...overrides,
  }
}

describe('saluran', () => {
  test('peristiwa ke Kafka, dengan amplop yang ditetapkan saat ditulis', async () => {
    const { sent, transport } = brokers()

    await transport.send(message({}))

    expect(sent).toEqual([
      {
        via: 'kafka',
        type: 'booking.held',
        payload: { bookingId: BOOKING, holdRef: 'h-1', expiresAt: '2026-10-01T03:15:00.000Z' },
        options: {
          eventId: '0199f000-0000-7000-8000-00000000abcd',
          occurredAt: '2026-10-01T03:00:00.000Z',
          correlationId: 'req-asal',
        },
      },
    ])
  })

  test('perintah ke RabbitMQ, dengan sebab dan jejaknya', async () => {
    const { sent, transport } = brokers()

    await transport.send(
      message({
        channel: 'rabbitmq',
        messageType: 'voucher.generate',
        payload: { bookingId: BOOKING },
        causationId: '0199f000-0000-7000-8000-00000000abce',
        traceparent: '00-abc-def-01',
      }),
    )

    expect(sent[0]).toMatchObject({
      via: 'rabbitmq',
      type: 'voucher.generate',
      options: {
        causationId: '0199f000-0000-7000-8000-00000000abce',
        traceparent: '00-abc-def-01',
      },
    })
  })

  test.each([
    ['perintah tercatat sebagai peristiwa', { channel: 'kafka', messageType: 'voucher.generate' }],
    ['peristiwa tercatat sebagai perintah', { channel: 'rabbitmq', messageType: 'booking.held' }],
    ['jenis yang tidak dikenal', { channel: 'kafka', messageType: 'booking.teleported' }],
  ] as const)('%s ditolak, tidak dikirim lewat broker yang salah', async (_label, overrides) => {
    const { sent, transport } = brokers()

    await expect(transport.send(message(overrides))).rejects.toBeInstanceOf(ValidationError)
    expect(sent).toEqual([])
  })

  test.each([
    ['peristiwa', message({ payload: { bookingId: 'bukan-uuid' } })],
    ['perintah', message({ channel: 'rabbitmq', messageType: 'voucher.generate', payload: {} })],
  ])(
    'payload %s yang tidak sesuai kontrak ditolak sebagai ValidationError',
    async (_label, bad) => {
      const { transport } = brokers()

      await expect(transport.send(bad)).rejects.toBeInstanceOf(ValidationError)
    },
  )
})
