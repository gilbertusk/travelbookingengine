import { createMessage } from '@tbe/event-contracts'
import {
  DEAD_LETTER_EXCHANGE,
  RETRY_EXCHANGE,
  createCommandConsumer,
  type PublishOptions,
  type RabbitPublisher,
} from '@tbe/messaging'
import { describe, expect, test } from 'vitest'
import { BOOKING_ID, confirmedSource, world, type World } from '../testing/fakes.js'
import { handleGenerate, refusalText } from './generate-command.js'

/**
 * Perintah dijalankan melalui pembungkus consumer YANG SESUNGGUHNYA dari
 * @tbe/messaging — keputusan antrian tunda atau dead letter adalah miliknya,
 * dan menguji tiruannya hanya membuktikan tiruannya benar.
 */

interface Published {
  readonly exchange: string
  readonly routingKey: string
  readonly options: PublishOptions
}

function recordingPublisher(): RabbitPublisher & { readonly published: Published[] } {
  const published: Published[] = []
  return {
    published,
    async publish(exchange, routingKey, _content, options) {
      published.push({ exchange, routingKey, options })
      await Promise.resolve()
    },
  }
}

async function deliver(w: World, bookingId = BOOKING_ID) {
  const publisher = recordingPublisher()
  const message = createMessage({ eventType: 'voucher.generate' as const, payload: { bookingId } })
  const consumer = createCommandConsumer({
    command: 'voucher.generate',
    publisher,
    logger: w.deps.logger,
    handle: handleGenerate(w.deps),
  })

  const outcome = await consumer({
    content: Buffer.from(JSON.stringify(message), 'utf8'),
    headers: {},
    routingKey: 'voucher.generate',
  })

  return { outcome, published: publisher.published }
}

describe('perintah voucher.generate', () => {
  test('perintah yang sama dua kali: keduanya di-ack, satu voucher', async () => {
    const w = world()

    const first = await deliver(w)
    const second = await deliver(w)

    expect([first.outcome, second.outcome]).toEqual(['ack', 'ack'])
    expect([...first.published, ...second.published]).toHaveLength(0)
    expect(w.vouchers.rows.size).toBe(1)
    expect(w.storage.objects.size).toBe(1)
  })

  test('pemesanan yang belum CONFIRMED langsung ke dead letter, tanpa dicoba ulang', async () => {
    const w = world({ sources: [confirmedSource({ status: 'PAID', supplierRef: null })] })

    const { outcome, published } = await deliver(w)

    expect(outcome).toBe('ack')
    expect(published.map((entry) => entry.exchange)).toEqual([DEAD_LETTER_EXCHANGE])
  })

  test('booking-service yang mati sesaat masuk antrian tunda jenjang pertama', async () => {
    const w = world()
    w.bookings.failNext = true

    const { outcome, published } = await deliver(w)

    expect(outcome).toBe('ack')
    expect(published).toHaveLength(1)
    expect(published[0]?.exchange).toBe(RETRY_EXCHANGE)
    expect(published[0]?.routingKey).toContain('t1')
    expect(w.vouchers.rows.size).toBe(0)
  })

  test('percobaan ulang sesudah dependensi pulih menerbitkan voucher', async () => {
    const w = world()
    w.bookings.failNext = true

    await deliver(w)
    const retried = await deliver(w)

    expect(retried.published).toHaveLength(0)
    expect(w.vouchers.rows.size).toBe(1)
  })
})

describe('properti yang belum terpetakan', () => {
  test('dicoba lagi, bukan langsung ke dead letter — pemesanannya sudah dibayar', async () => {
    const w = world({ property: null })

    const { outcome, published } = await deliver(w)

    expect(outcome).toBe('ack')
    expect(published.map((entry) => entry.exchange)).toEqual([RETRY_EXCHANGE])
  })
})

describe('teks penolakan untuk dead letter', () => {
  test.each([
    [{ kind: 'booking_not_found' } as const, 'tidak ditemukan'],
    [{ kind: 'property_unmapped' } as const, 'belum terpetakan'],
    [{ kind: 'not_confirmed', status: 'HELD' } as const, 'status HELD'],
    [{ kind: 'missing_reference' } as const, 'booking reference'],
  ])('%j', (refusal, expected) => {
    expect(refusalText(refusal)).toContain(expected)
  })
})
