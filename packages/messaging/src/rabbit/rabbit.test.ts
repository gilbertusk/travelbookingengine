import { COMMAND_TYPES, createMessage, type CommandType } from '@tbe/event-contracts'
import { UpstreamError, ValidationError, getCorrelationId } from '@tbe/shared-kernel'
import { describe, expect, test } from 'vitest'
import { LAST_RETRY_TIER, RETRY_COUNT_HEADER, RETRY_TIERS } from '../retry.js'
import { fakeRabbitPublisher, silentLogger } from '../testing.js'
import { createCommandConsumer } from './consumer.js'
import { createCommandSender } from './sender.js'
import {
  COMMAND_EXCHANGE,
  DEAD_LETTER_EXCHANGE,
  RETRY_EXCHANGE,
  deadLetterQueue,
  mainQueue,
  retryQueue,
  topologyFor,
} from './topology.js'

const BOOKING_ID = '01927f3a-0000-7000-8000-000000000001'
const COMMAND: CommandType = 'supplier.confirm'

const validPayload = {
  bookingId: BOOKING_ID,
  supplier: 'SKY' as const,
  holdRef: 'hld_1',
  guestName: 'Budi',
  idempotencyKey: 'idem-1',
}

function incoming(payload: unknown, headers: Record<string, unknown> = {}) {
  const message =
    payload === 'rusak'
      ? '{ ini bukan json'
      : JSON.stringify(createMessage({ eventType: COMMAND, payload }))

  return { content: Buffer.from(message, 'utf8'), headers, routingKey: COMMAND }
}

describe('topologi', () => {
  const topology = topologyFor()

  test('mendeklarasikan tiga exchange yang berbeda peran', () => {
    expect(topology.exchanges.map((e) => e.name)).toEqual([
      COMMAND_EXCHANGE,
      RETRY_EXCHANGE,
      DEAD_LETTER_EXCHANGE,
    ])
  })

  test('setiap perintah punya antrian utama, antrian tunda, dan dead letter', () => {
    const names = new Set(topology.queues.map((queue) => queue.name))

    for (const command of COMMAND_TYPES) {
      expect(names.has(mainQueue(command))).toBe(true)
      expect(names.has(deadLetterQueue(command))).toBe(true)

      for (const tier of RETRY_TIERS) {
        expect(names.has(retryQueue(command, tier.name))).toBe(true)
      }
    }
  })

  test('antrian tunda mengembalikan pesan ke antrian utama setelah TTL', () => {
    // Inilah yang membuat penundaan tidak butuh penjadwal: RabbitMQ sendiri
    // yang mengembalikan pesan, dan tidak ada timer yang hilang saat restart.
    const tunda = topology.queues.find((q) => q.name === retryQueue(COMMAND, RETRY_TIERS[0]!.name))

    expect(tunda?.arguments).toEqual({
      'x-message-ttl': RETRY_TIERS[0]?.delayMs,
      'x-dead-letter-exchange': COMMAND_EXCHANGE,
      'x-dead-letter-routing-key': COMMAND,
    })
  })

  test('setiap antrian punya binding', () => {
    // Antrian tanpa binding tidak akan pernah menerima pesan, dan tidak ada
    // yang memberi tahu — ia hanya diam kosong selamanya.
    const bound = new Set(topology.bindings.map((binding) => binding.queue))

    expect(topology.queues.filter((queue) => !bound.has(queue.name))).toEqual([])
  })

  test('seluruh nama antrian dan exchange berawalan tbe.', () => {
    const names = [
      ...topology.queues.map((queue) => queue.name),
      ...topology.exchanges.map((exchange) => exchange.name),
    ]

    expect(names.filter((name) => !name.startsWith('tbe.'))).toEqual([])
  })

  test('nama antrian unik', () => {
    const names = topology.queues.map((queue) => queue.name)

    expect(new Set(names).size).toBe(names.length)
  })
})

describe('pengirim perintah', () => {
  test('menerbitkan ke exchange perintah dengan routing key jenis perintahnya', async () => {
    const publisher = fakeRabbitPublisher()

    await createCommandSender(publisher).send(COMMAND, validPayload)

    expect(publisher.published[0]?.exchange).toBe(COMMAND_EXCHANGE)
    expect(publisher.published[0]?.routingKey).toBe(COMMAND)
  })

  test('menolak payload yang tidak sesuai kontrak sebelum dikirim', async () => {
    // Perintah cacat yang sudah masuk antrian hanya bisa berakhir di dead
    // letter, dan pada titik itu pemanggilnya sudah lama pergi.
    const publisher = fakeRabbitPublisher()
    const sender = createCommandSender(publisher)

    await expect(
      sender.send(COMMAND, { ...validPayload, idempotencyKey: '' }),
    ).rejects.toBeInstanceOf(ValidationError)
    expect(publisher.published).toHaveLength(0)
  })

  test('menyetel hitungan percobaan awal ke nol', async () => {
    const publisher = fakeRabbitPublisher()

    await createCommandSender(publisher).send(COMMAND, validPayload)

    expect(publisher.published[0]?.options.headers[RETRY_COUNT_HEADER]).toBe(0)
  })

  test('memakai amplop yang sudah ditetapkan outbox', async () => {
    // Perintah outbox yang dikirim ulang harus membawa eventId yang sama.
    const publisher = fakeRabbitPublisher()
    const eventId = '0199f000-0000-7000-8000-00000000abcd'

    await createCommandSender(publisher).send('supplier.confirm', validPayload, {
      eventId,
      correlationId: 'req-asal',
      occurredAt: '2026-10-01T03:00:00.000Z',
    })

    const sent = JSON.parse(publisher.published[0]?.content ?? '{}') as Record<string, unknown>
    expect(sent).toMatchObject({
      eventId,
      correlationId: 'req-asal',
      occurredAt: '2026-10-01T03:00:00.000Z',
    })
    expect(publisher.published[0]?.options.messageId).toBe(eventId)
  })

  test('menandai pesan persisten agar selamat dari restart broker', async () => {
    const publisher = fakeRabbitPublisher()

    await createCommandSender(publisher).send(COMMAND, validPayload)

    expect(publisher.published[0]?.options.persistent).toBe(true)
  })
})

describe('consumer perintah', () => {
  function consumerWith(handle: (payload: unknown) => Promise<void>) {
    const publisher = fakeRabbitPublisher()
    const consume = createCommandConsumer({
      command: COMMAND,
      publisher,
      logger: silentLogger(),
      handle: async (payload) => {
        await handle(payload)
      },
    })

    return { publisher, consume }
  }

  test('meneruskan payload yang sudah tervalidasi ke handler', async () => {
    let diterima: unknown
    const { consume } = consumerWith(async (payload) => {
      diterima = payload
      await Promise.resolve()
    })

    const outcome = await consume(incoming(validPayload))

    expect(outcome).toBe('ack')
    expect(diterima).toEqual(validPayload)
  })

  test('memulihkan correlationId ke konteks yang sedang berjalan', async () => {
    // Tanpa ini, log dari saga asinkron tidak dapat dihubungkan kembali ke
    // permintaan HTTP yang memulainya.
    let terlihat: string | undefined
    const { consume } = consumerWith(async () => {
      terlihat = getCorrelationId()
      await Promise.resolve()
    })
    const message = incoming(validPayload)
    const correlationId = (
      JSON.parse(message.content.toString('utf8')) as { correlationId: string }
    ).correlationId

    await consume(message)

    expect(terlihat).toBe(correlationId)
  })

  test('pesan cacat langsung ke dead letter tanpa dicoba ulang', async () => {
    const { publisher, consume } = consumerWith(async () => Promise.resolve())

    const outcome = await consume(incoming('rusak'))

    expect(outcome).toBe('ack')
    expect(publisher.published[0]?.exchange).toBe(DEAD_LETTER_EXCHANGE)
  })

  test('payload yang tidak sesuai kontrak juga langsung ke dead letter', async () => {
    const { publisher, consume } = consumerWith(async () => Promise.resolve())

    await consume(incoming({ ...validPayload, idempotencyKey: '' }))

    expect(publisher.published[0]?.exchange).toBe(DEAD_LETTER_EXCHANGE)
  })

  test('handler tidak pernah dipanggil untuk pesan cacat', async () => {
    let dipanggil = false
    const { consume } = consumerWith(async () => {
      dipanggil = true
      await Promise.resolve()
    })

    await consume(incoming('rusak'))

    expect(dipanggil).toBe(false)
  })

  test('kegagalan sementara dijadwalkan ke jenjang tunda pertama', async () => {
    const { publisher, consume } = consumerWith(async () => {
      await Promise.resolve()
      throw new UpstreamError({ upstream: 'SKY', message: 'gagal' })
    })

    const outcome = await consume(incoming(validPayload))

    expect(outcome).toBe('ack')
    expect(publisher.published[0]?.exchange).toBe(RETRY_EXCHANGE)
    expect(publisher.published[0]?.routingKey).toBe(`${COMMAND}.${RETRY_TIERS[0]?.name ?? ''}`)
    expect(publisher.published[0]?.options.headers[RETRY_COUNT_HEADER]).toBe(1)
  })

  test('berpindah jenjang sesuai jumlah percobaan sebelumnya', async () => {
    const { publisher, consume } = consumerWith(async () => {
      await Promise.resolve()
      throw new UpstreamError({ upstream: 'SKY', message: 'gagal' })
    })

    await consume(incoming(validPayload, { [RETRY_COUNT_HEADER]: 1 }))

    expect(publisher.published[0]?.routingKey).toBe(`${COMMAND}.${RETRY_TIERS[1]?.name ?? ''}`)
  })

  test('setelah jenjang habis, masuk dead letter', async () => {
    const { publisher, consume } = consumerWith(async () => {
      await Promise.resolve()
      throw new UpstreamError({ upstream: 'SKY', message: 'gagal' })
    })

    await consume(incoming(validPayload, { [RETRY_COUNT_HEADER]: RETRY_TIERS.length }))

    expect(publisher.published[0]?.exchange).toBe(DEAD_LETTER_EXCHANGE)
  })

  test('kegagalan final tidak menghabiskan jenjang tunda', async () => {
    const { publisher, consume } = consumerWith(async () => {
      await Promise.resolve()
      throw new ValidationError('payload ditolak sistem hulu')
    })

    await consume(incoming(validPayload))

    expect(publisher.published[0]?.exchange).toBe(DEAD_LETTER_EXCHANGE)
  })

  test('pesan dikembalikan ke antrian bila penerbitan ulang gagal', async () => {
    // Meng-ack pesan yang gagal diterbitkan ulang berarti pekerjaannya hilang
    // tanpa jejak.
    const { publisher, consume } = consumerWith(async () => {
      await Promise.resolve()
      throw new UpstreamError({ upstream: 'SKY', message: 'gagal' })
    })
    publisher.failNext()

    const outcome = await consume(incoming(validPayload))

    expect(outcome).toBe('requeue')
  })
})

describe('kabar dead letter (Step 19)', () => {
  type Seen = {
    reason: string
    error: unknown
    payload: unknown
    correlationId: string | undefined
  }

  function consumerWithHook(options: { failHook?: boolean; error?: Error } = {}) {
    const publisher = fakeRabbitPublisher()
    const seen: Seen[] = []
    const consume = createCommandConsumer({
      command: COMMAND,
      publisher,
      logger: silentLogger(),
      handle: async () => {
        await Promise.resolve()
        throw options.error ?? new UpstreamError({ upstream: 'SKY', message: 'gagal' })
      },
      onDeadLetter: async ({ reason, error, payload }) => {
        await Promise.resolve()
        seen.push({ reason, error, payload, correlationId: getCorrelationId() })
        if (options.failHook === true) throw new Error('kafka tidak dapat dihubungi')
      },
    })

    return { publisher, consume, seen }
  }

  const exhausted = { [RETRY_COUNT_HEADER]: RETRY_TIERS.length }

  test('perintah yang percobaannya habis dikabarkan sebelum masuk dead letter', async () => {
    // Tanpa kabar ini, pengirim perintah — saga yang menunggu hasil
    // supplier.confirm — tidak pernah tahu perintahnya berakhir.
    const { publisher, consume, seen } = consumerWithHook()

    await consume(incoming(validPayload, exhausted))

    expect(seen).toMatchObject([{ reason: 'exhausted', payload: validPayload }])
    expect(seen[0]?.error).toBeInstanceOf(UpstreamError)
    expect(publisher.published[0]?.exchange).toBe(DEAD_LETTER_EXCHANGE)
  })

  test('kegagalan final juga dikabarkan, dengan alasannya', async () => {
    const { consume, seen } = consumerWithHook({ error: new ValidationError('ditolak') })

    await consume(incoming(validPayload))

    expect(seen.map((entry) => entry.reason)).toEqual(['not_retryable'])
  })

  test('kegagalan yang masih akan dicoba ulang TIDAK dikabarkan', async () => {
    const { consume, seen } = consumerWithHook()

    await consume(incoming(validPayload))

    expect(seen).toEqual([])
  })

  test('pesan cacat tidak dikabarkan: tidak ada payload yang dapat dipercaya', async () => {
    const { consume, seen } = consumerWithHook()

    await consume(incoming('rusak'))

    expect(seen).toEqual([])
  })

  test('kabar berjalan di bawah correlationId perintahnya', async () => {
    const { consume, seen } = consumerWithHook()
    const message = incoming(validPayload, exhausted)
    const { correlationId } = JSON.parse(message.content.toString('utf8')) as {
      correlationId: string
    }

    await consume(message)

    expect(seen[0]?.correlationId).toBe(correlationId)
  })

  test('kabar yang gagal menunda ulang perintah di jenjang terakhir, bukan membuangnya', async () => {
    // Dead letter tanpa kabar adalah persis kesunyian yang ingin dihapus. Pesan
    // kembali ke jenjang tunda terakhir dengan hitungan yang TIDAK naik, dan
    // akan tiba lagi di sini setelah tundaannya.
    const { publisher, consume } = consumerWithHook({ failHook: true })

    const outcome = await consume(incoming(validPayload, exhausted))

    expect(outcome).toBe('ack')
    expect(publisher.published).toHaveLength(1)
    expect(publisher.published[0]?.exchange).toBe(RETRY_EXCHANGE)
    expect(publisher.published[0]?.routingKey).toBe(`${COMMAND}.${LAST_RETRY_TIER.name}`)
    expect(publisher.published[0]?.options.headers[RETRY_COUNT_HEADER]).toBe(RETRY_TIERS.length)
  })
})
