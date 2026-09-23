import { DEAD_LETTER_TOPIC, createMessage, topicFor, type EventType } from '@tbe/event-contracts'
import { ValidationError, getCorrelationId } from '@tbe/shared-kernel'
import { describe, expect, test } from 'vitest'
import { fakeKafkaProducer, silentLogger } from '../testing.js'
import { createEventConsumer } from './consumer.js'
import { createEventPublisher, partitionKeyOf } from './publisher.js'

const BOOKING_ID = '01927f3a-0000-7000-8000-000000000001'
const USER_ID = '01927f3a-0000-7000-8000-000000000002'

const bookingCreated = {
  bookingId: BOOKING_ID,
  userId: USER_ID,
  supplier: 'SKY' as const,
  propertyId: 'prp_1',
  ratePlanRef: 'rpl_1',
  checkIn: '2026-11-10',
  checkOut: '2026-11-12',
  guests: 2,
  amount: { amountMinor: 2_400_000, currency: 'IDR' as const },
}

function incoming(raw: string, topic = 'tbe.booking.v1') {
  return { topic, partition: 0, value: Buffer.from(raw, 'utf8'), headers: {} }
}

function encoded(type: EventType, payload: unknown): string {
  return JSON.stringify(createMessage({ eventType: type, payload }))
}

describe('penerbit peristiwa', () => {
  test('menerbitkan ke topik milik jenis peristiwanya', async () => {
    const producer = fakeKafkaProducer()

    await createEventPublisher(producer).publish('booking.created', bookingCreated)

    expect(producer.sent[0]?.topic).toBe(topicFor('booking.created').name)
  })

  test('memakai kunci partisi sesuai definisi topik', async () => {
    // Kunci yang salah berarti urutan per pemesanan tidak terjaga, dan
    // booking.confirmed dapat tiba sebelum booking.created.
    const producer = fakeKafkaProducer()

    await createEventPublisher(producer).publish('booking.created', bookingCreated)

    expect(producer.sent[0]?.records[0]?.key).toBe(BOOKING_ID)
  })

  test('menyertakan jenis peristiwa dan correlationId pada header', async () => {
    const producer = fakeKafkaProducer()

    await createEventPublisher(producer).publish('booking.created', bookingCreated)

    const headers = producer.sent[0]?.records[0]?.headers
    expect(headers?.['x-event-type']).toBe('booking.created')
    expect(headers?.['x-correlation-id']).toBeDefined()
  })

  test('meneruskan traceparent agar penelusuran tidak terputus', async () => {
    const producer = fakeKafkaProducer()

    await createEventPublisher(producer).publish('booking.created', bookingCreated, {
      traceparent: '00-4bf92f-00f067-01',
    })

    expect(producer.sent[0]?.records[0]?.headers.traceparent).toBe('00-4bf92f-00f067-01')
  })

  test('menolak payload yang tidak sesuai kontrak sebelum dikirim', async () => {
    const producer = fakeKafkaProducer()
    const publisher = createEventPublisher(producer)

    await expect(
      publisher.publish('booking.created', { ...bookingCreated, guests: 0 }),
    ).rejects.toBeInstanceOf(ValidationError)
    expect(producer.sent).toHaveLength(0)
  })

  test('menolak menerbitkan tanpa kunci partisi', () => {
    // Kunci yang hilang membuat Kafka menyebar pesan round-robin, dan urutan
    // hilang tanpa satu pun galat muncul.
    expect(() => partitionKeyOf({ bookingId: '' }, 'bookingId')).toThrow(ValidationError)
    expect(() => partitionKeyOf({}, 'supplier')).toThrow(ValidationError)
    expect(() => partitionKeyOf(null, 'city')).toThrow(ValidationError)
  })

  test('peristiwa supplier dikunci kode suppliernya', async () => {
    const producer = fakeKafkaProducer()

    await createEventPublisher(producer).publish('supplier.recovered', { supplier: 'LUNA' })

    expect(producer.sent[0]?.records[0]?.key).toBe('LUNA')
  })
})

describe('consumer peristiwa', () => {
  function consumerWith(
    subscribedTo: readonly EventType[],
    handle: (message: { eventType: string }) => Promise<void>,
  ) {
    const producer = fakeKafkaProducer()
    const consume = createEventConsumer({
      subscribedTo,
      producer,
      logger: silentLogger(),
      handle: async (message) => {
        await handle(message)
      },
    })

    return { producer, consume }
  }

  test('meneruskan peristiwa yang diminta ke handler', async () => {
    let diterima = ''
    const { consume } = consumerWith(['booking.created'], async (message) => {
      diterima = message.eventType
      await Promise.resolve()
    })

    await consume(incoming(encoded('booking.created', bookingCreated)))

    expect(diterima).toBe('booking.created')
  })

  test('melewati peristiwa yang tidak diminta tanpa suara', async () => {
    // Satu topik membawa beberapa jenis peristiwa; yang tidak diminta bukan
    // kesalahan dan tidak boleh masuk dead letter.
    let dipanggil = false
    const { producer, consume } = consumerWith(['booking.confirmed'], async () => {
      dipanggil = true
      await Promise.resolve()
    })

    await consume(incoming(encoded('booking.created', bookingCreated)))

    expect(dipanggil).toBe(false)
    expect(producer.sent).toHaveLength(0)
  })

  test('memulihkan correlationId ke konteks yang sedang berjalan', async () => {
    let terlihat: string | undefined
    const { consume } = consumerWith(['booking.created'], async () => {
      terlihat = getCorrelationId()
      await Promise.resolve()
    })
    const raw = encoded('booking.created', bookingCreated)

    await consume(incoming(raw))

    expect(terlihat).toBe((JSON.parse(raw) as { correlationId: string }).correlationId)
  })

  test('pesan cacat dikirim ke dead letter tanpa melempar', async () => {
    // Melempar berarti offset tidak ter-commit dan partisi berhenti selamanya
    // pada pesan yang tidak akan pernah bisa diproses.
    const { producer, consume } = consumerWith(['booking.created'], async () => Promise.resolve())

    await expect(consume(incoming('{ bukan json'))).resolves.toBeUndefined()
    expect(producer.sent[0]?.topic).toBe(DEAD_LETTER_TOPIC)
  })

  test('payload yang tidak sesuai kontrak juga masuk dead letter', async () => {
    const { producer, consume } = consumerWith(['booking.created'], async () => Promise.resolve())

    await consume(incoming(encoded('booking.created', { ...bookingCreated, guests: 0 })))

    expect(producer.sent[0]?.topic).toBe(DEAD_LETTER_TOPIC)
  })

  test('peristiwa dengan jenis tidak dikenal masuk dead letter', async () => {
    const { producer, consume } = consumerWith(['booking.created'], async () => Promise.resolve())

    await consume(incoming(JSON.stringify({ eventType: 'sesuatu.yang.lain', payload: {} })))

    expect(producer.sent[0]?.topic).toBe(DEAD_LETTER_TOPIC)
  })

  test('pesan bernilai null masuk dead letter, bukan melempar', async () => {
    const { producer, consume } = consumerWith(['booking.created'], async () => Promise.resolve())

    await consume({ topic: 'tbe.booking.v1', partition: 0, value: null, headers: {} })

    expect(producer.sent[0]?.topic).toBe(DEAD_LETTER_TOPIC)
  })

  test('galat handler dilempar ulang agar offset tidak ter-commit', async () => {
    // Kegagalan pemrosesan berbeda dari pesan cacat: pesannya benar, yang
    // gagal adalah pekerjaannya, dan pesan itu harus dibaca lagi.
    const { consume } = consumerWith(['booking.created'], async () => {
      await Promise.resolve()
      throw new Error('database sedang tidak dapat dihubungi')
    })

    await expect(consume(incoming(encoded('booking.created', bookingCreated)))).rejects.toThrow(
      'database sedang tidak dapat dihubungi',
    )
  })

  test('dead letter membawa topik asal untuk penelusuran', async () => {
    const { producer, consume } = consumerWith(['booking.created'], async () => Promise.resolve())

    await consume(incoming('{ rusak', 'tbe.payment.v1'))

    expect(producer.sent[0]?.records[0]?.headers['x-origin-topic']).toBe('tbe.payment.v1')
  })
})
