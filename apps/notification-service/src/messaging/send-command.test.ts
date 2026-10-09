import { createMessage, type CommandPayload } from '@tbe/event-contracts'
import {
  DEAD_LETTER_EXCHANGE,
  RETRY_EXCHANGE,
  createCommandConsumer,
  type RabbitPublisher,
} from '@tbe/messaging'
import { describe, expect, test } from 'vitest'
import { deliverDue } from '../application/deliver.js'
import { BOOKING_ID, USER, world, type World } from '../testing/fakes.js'
import { handleSendCommand } from './send-command.js'

/** Lewat pembungkus consumer perintah @tbe/messaging yang sama dengan produksi. */

interface Published {
  readonly exchange: string
  readonly routingKey: string
}

function harness(w: World = world()) {
  const published: Published[] = []
  const wakes = { count: 0 }
  const publisher: RabbitPublisher = {
    async publish(exchange, routingKey) {
      published.push({ exchange, routingKey })
      await Promise.resolve()
    },
  }
  const consumer = createCommandConsumer({
    command: 'notification.send',
    publisher,
    logger: w.deps.logger,
    handle: handleSendCommand(w.deps, () => {
      wakes.count += 1
    }),
  })

  return {
    w,
    published,
    wakes,
    async send(payload: CommandPayload<'notification.send'>, eventId?: string) {
      const message = createMessage({
        eventType: 'notification.send',
        payload,
        correlationId: 'corr-1',
        ...(eventId === undefined ? {} : { eventId }),
      })
      return await consumer({
        content: Buffer.from(JSON.stringify(message)),
        headers: {},
        routingKey: 'notification.send',
      })
    },
  }
}

const REQUEST: CommandPayload<'notification.send'> = {
  bookingId: BOOKING_ID,
  userId: USER,
  template: 'booking_confirmed',
  channel: 'email',
}

describe('consumer perintah RabbitMQ notification.send', () => {
  test('mengerjakan permintaan eksplisit: surel yang diminta terkirim', async () => {
    const h = harness()

    expect(await h.send(REQUEST)).toBe('ack')
    await deliverDue(h.w.deps)

    expect(h.w.sender.sent).toHaveLength(1)
    expect(h.w.notifications.rows[0]?.request).toMatchObject({ source: 'command', userId: USER })
    expect(h.wakes.count).toBe(1)
  })

  test('perintah yang SAMA diantar ulang tidak menghasilkan surel kedua', async () => {
    const h = harness()
    const commandId = '018f2a1c-0000-7000-8000-0000000c0001'

    await h.send(REQUEST, commandId)
    await h.send(REQUEST, commandId)
    await deliverDue(h.w.deps)

    expect(h.w.sender.sent).toHaveLength(1)
  })

  test('dua perintah berbeda adalah dua permintaan — kirim ulang yang disengaja tetap dikerjakan', async () => {
    const h = harness()

    await h.send(REQUEST)
    await h.send(REQUEST)

    expect(h.w.notifications.rows).toHaveLength(2)
  })

  test('perintah tanpa pemesanan langsung ke dead letter, tidak dicoba ulang', async () => {
    const h = harness()
    await h.send({ userId: USER, template: 'booking_confirmed', channel: 'email' })

    expect(h.published).toEqual([
      { exchange: DEAD_LETTER_EXCHANGE, routingKey: 'notification.send' },
    ])
    expect(h.w.notifications.rows).toEqual([])
  })

  test('basis data yang mati menjadwalkan perintah ke antrian tunda', async () => {
    const h = harness()
    h.w.notifications.failNext = true

    await h.send(REQUEST)

    expect(h.published[0]?.exchange).toBe(RETRY_EXCHANGE)
  })
})
