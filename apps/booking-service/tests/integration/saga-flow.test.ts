import { randomUUID } from 'node:crypto'
import { topicFor } from '@tbe/event-contracts'
import {
  consumerResource,
  createCommandSender,
  createEventConsumer,
  createEventPublisher,
  createKafkaClient,
  producerResource,
  toProducerPort,
} from '@tbe/messaging'
import { toJson } from '@tbe/money'
import { createLogger } from '@tbe/shared-kernel'
import { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { slotOf } from '../../src/application/hold-slot.js'
import { placeHold } from '../../src/application/place-hold.js'
import type { BookingDeps } from '../../src/application/ports.js'
import { startPriceCheck } from '../../src/application/price-check.js'
import { refundRequestIdFor } from '../../src/application/saga/commands.js'
import type { Booking } from '../../src/domain/booking.js'
import { outboxPublisher } from '../../src/composition/app.js'
import { createOutboxRelay } from '../../src/infrastructure/outbox-relay.js'
import { createMessagingTransport } from '../../src/infrastructure/outbox-transport.js'
import { createPrismaBookingRepository } from '../../src/infrastructure/prisma-booking-repository.js'
import { bookingDbOf, createPrismaClient } from '../../src/infrastructure/prisma-client.js'
import { createPrismaSagaStore } from '../../src/infrastructure/prisma-saga-store.js'
import { createRedisHoldStore } from '../../src/infrastructure/redis-hold-store.js'
import { systemClock } from '../../src/infrastructure/system.js'
import { SAGA_EVENTS, handleSagaEvent } from '../../src/messaging/saga-events.js'
import {
  priceCheckRequest,
  SAGA_POLICY,
  scriptedPricing,
  scriptedProperties,
  scriptedSuppliers,
} from '../../src/testing/fakes.js'
import { caughtUp, commandObserver, eventObserver, eventually } from './brokers.js'
import { brokerEnv, integrationEnv } from './env.js'

/**
 * Saga ujung ke ujung terhadap infrastruktur SUNGGUHAN: PostgreSQL, Redis,
 * Kafka, dan RabbitMQ (NFR-19: jalur kompensasi diuji dengan infrastruktur
 * sungguhan, bukan tiruan).
 *
 * booking-service berjalan dengan bagian produksinya — use case, repository,
 * outbox beserta penerbitnya, consumer Kafka @tbe/messaging, reaksi saga.
 * Uji ini memerankan payment-service dan supplier-service: menerbitkan
 * peristiwa mereka ke Kafka, dan membaca perintah untuk mereka dari RabbitMQ.
 * supplier-service dan payment-service sendiri tidak berjalan; perilakunya
 * diuji di service masing-masing, dan alur lintas service yang berjalan
 * bersamaan adalah Step 20.
 */

const { databaseUrl, redisUrl } = integrationEnv()
const { kafkaBrokers } = brokerEnv()
const logger = createLogger({ serviceName: 'booking-it', level: 'silent' })
const prisma = createPrismaClient(databaseUrl)
const db = bookingDbOf(prisma)
const redis = new Redis(redisUrl, { maxRetriesPerRequest: null })
const kafka = createKafkaClient({ clientId: 'booking-it', brokers: kafkaBrokers })
const producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1 })
const groupId = `booking-it-saga-${String(Date.now())}`
const consumer = kafka.consumer({ groupId })
const admin = kafka.admin()
const events = createEventPublisher(toProducerPort(producer))

const deps: BookingDeps = {
  bookings: createPrismaBookingRepository(db),
  sagas: createPrismaSagaStore(db),
  sagaPolicy: SAGA_POLICY,
  suppliers: scriptedSuppliers(() => new Date()),
  pricing: scriptedPricing(),
  properties: scriptedProperties(),
  holds: createRedisHoldStore(redis),
  clock: systemClock,
  ids: { next: () => randomUUID() },
  holdPolicy: { durationMs: 15 * 60_000, sweepBatch: 100 },
  logger,
}

let commands: Awaited<ReturnType<typeof commandObserver>>
let published: Awaited<ReturnType<typeof eventObserver>>
let stopAll: () => Promise<void> = async () => {
  await Promise.resolve()
}

beforeAll(async () => {
  // Seluruh pemesanan di berkas ini memakai slot yang sama. Kursi pemesanan
  // yang sudah dibayar tetap tertahan sampai kunci waktunya habis (15 menit),
  // jadi tanpa ini putaran uji berikutnya dalam 15 menit menemukan slot yang
  // penuh oleh sisa putaran sebelumnya — ketergantungan tersembunyi yang
  // sama dengan yang ditemukan pengacakan di Step 17.
  await redis.flushdb()
  commands = await commandObserver([
    'supplier.confirm',
    'payment.refund',
    'supplier.cancel',
    'voucher.generate',
  ])
  published = await eventObserver([topicFor('booking.created').name])
  const relay = createOutboxRelay(
    db,
    createMessagingTransport(events, createCommandSender(commands.rabbit.publisher)),
    { batch: 100, transactionTimeoutMs: 30_000, now: () => new Date(), logger },
  )
  const joined = new Promise<void>((resolve) => {
    consumer.on(consumer.events.GROUP_JOIN, () => {
      resolve()
    })
  })
  const resources = [
    producerResource(producer),
    outboxPublisher(relay, { intervalMs: 50, batch: 100, logger }),
    consumerResource({
      consumer,
      topics: [topicFor('payment.succeeded').name, topicFor('supplier.booking_confirmed').name],
      handler: createEventConsumer({
        subscribedTo: SAGA_EVENTS,
        producer: toProducerPort(producer),
        logger,
        handle: async (message) => {
          await handleSagaEvent(deps)(message)
        },
      }),
    }),
  ]
  for (const resource of resources) await resource.start?.()
  await admin.connect()
  await joined
  stopAll = async () => {
    await admin.disconnect()
    for (const resource of [...resources].reverse()) await resource.stop()
    await commands.stop()
    await published.stop()
  }
}, 90_000)

afterAll(async () => {
  await stopAll()
  await redis.quit()
  await prisma.$disconnect()
}, 30_000)

let keys = 0
async function held(): Promise<Booking> {
  keys += 1
  const userId = randomUUID()
  const key = `it-saga-${String(Date.now())}-${String(keys)}`
  const checked = await startPriceCheck(deps, priceCheckRequest({ userId, key }))
  if (checked.kind !== 'checked') throw new Error(`price check gagal: ${checked.kind}`)
  const result = await placeHold(deps, { userId, bookingId: checked.booking.id, unitsLeft: 50 })
  if (result.kind !== 'held') throw new Error(`hold gagal: ${result.kind}`)
  return result.booking
}

async function status(bookingId: string): Promise<string | undefined> {
  return (await deps.bookings.findById(bookingId))?.status
}

function commandsFor(bookingId: string, type: string) {
  return commands.seen.filter((seen) => seen.type === type && seen.payload.bookingId === bookingId)
}

const PAYMENT_ID = '7c0d5f0a-1b2c-4d3e-8f40-5a6b7c8d9e0f'

async function paid(): Promise<Booking> {
  const booking = await held()
  await events.publish('payment.succeeded', {
    paymentId: PAYMENT_ID,
    bookingId: booking.id,
    amount: toJson(booking.price.total),
    gatewayRef: 'MID-IT',
  })
  await eventually(
    'supplier.confirm tiba di RabbitMQ',
    () => commandsFor(booking.id, 'supplier.confirm').length === 1,
  )
  return booking
}

describe('saga terhadap PostgreSQL, Redis, Kafka, dan RabbitMQ sungguhan', () => {
  test('outbox: booking.created sampai di Kafka dengan eventId baris outbox-nya', async () => {
    const booking = await held()

    await eventually('booking.created sampai di Kafka', () =>
      published.seen.some(
        (seen) => seen.type === 'booking.created' && seen.payload.bookingId === booking.id,
      ),
    )
    const row = await prisma.outboxMessage.findFirst({
      where: { bookingId: booking.id, messageType: 'booking.created' },
    })
    const seen = published.seen.find(
      (event) => event.type === 'booking.created' && event.payload.bookingId === booking.id,
    )
    expect(seen).toMatchObject({ eventId: row?.id, key: booking.id })
    expect(seen?.occurredAt).toBe(row?.occurredAt.toISOString())
  })

  test('US-03: supplier menolak setelah pembayaran — refund lewat RabbitMQ, hold lepas, REFUNDED', async () => {
    const booking = await paid()
    expect(await status(booking.id)).toBe('PAID')

    await events.publish('supplier.booking_rejected', {
      bookingId: booking.id,
      supplier: 'SKY',
      reason: 'sold_out',
    })

    await eventually(
      'payment.refund tiba di RabbitMQ',
      () => commandsFor(booking.id, 'payment.refund').length === 1,
    )
    expect(await status(booking.id)).toBe('FAILED')
    expect(await redis.sismember(`booking:hold:members:${slotOf(booking)}`, booking.id)).toBe(0)
    expect(commandsFor(booking.id, 'payment.refund')[0]?.payload).toMatchObject({
      refundRequestId: refundRequestIdFor(booking.id, PAYMENT_ID),
      reason: 'supplier_failed',
    })

    await events.publish('payment.refunded', {
      refundId: randomUUID(),
      paymentId: PAYMENT_ID,
      bookingId: booking.id,
      amount: toJson(booking.price.total),
    })

    await eventually('REFUNDED', async () => (await status(booking.id)) === 'REFUNDED')
    expect(await deps.sagas.find(booking.id)).toMatchObject({ phase: 'compensated' })
  })

  test('US-05: status tidak pasti — NEEDS_REVIEW, dan TIDAK ADA refund di RabbitMQ', async () => {
    const booking = await paid()

    await events.publish('supplier.booking_uncertain', {
      bookingId: booking.id,
      supplier: 'SKY',
      idempotencyKey: booking.id,
      reason: 'timeout',
    })

    await eventually('NEEDS_REVIEW', async () => (await status(booking.id)) === 'NEEDS_REVIEW')
    // Perintah refund hanya mungkin lahir di outbox, dalam transaksi yang sama
    // dengan perubahan keadaan. Begitu NEEDS_REVIEW terbaca, isi outbox
    // pemesanan ini sudah final — tidak perlu menunggu penerbitnya.
    expect(
      await prisma.outboxMessage.count({
        where: { bookingId: booking.id, messageType: 'payment.refund' },
      }),
    ).toBe(0)
    expect(commandsFor(booking.id, 'payment.refund')).toEqual([])
  })

  test('pembayaran gagal setelah hold: CANCELLED dan kursi Redis kembali', async () => {
    const booking = await held()

    await events.publish('payment.failed', {
      paymentId: PAYMENT_ID,
      bookingId: booking.id,
      reason: 'ditolak bank',
    })

    await eventually('CANCELLED', async () => (await status(booking.id)) === 'CANCELLED')
    expect(await redis.sismember(`booking:hold:members:${slotOf(booking)}`, booking.id)).toBe(0)
  })

  test('pesan Kafka yang sama dua kali: tepat satu supplier.confirm', async () => {
    const booking = await held()
    const eventId = randomUUID()
    const payment = {
      paymentId: PAYMENT_ID,
      bookingId: booking.id,
      amount: toJson(booking.price.total),
      gatewayRef: 'MID-IT',
    }

    await events.publish('payment.succeeded', payment, { eventId })
    await events.publish('payment.succeeded', payment, { eventId })

    await eventually(
      'supplier.confirm tiba',
      () => commandsFor(booking.id, 'supplier.confirm').length >= 1,
    )
    // Kiriman KEDUA sudah dikerjakan — bukan sekadar belum sempat dibaca.
    await eventually(
      'consumer membaca kedua kiriman',
      async () => await caughtUp(admin, groupId, topicFor('payment.succeeded').name),
    )
    await eventually('outbox pemesanan terkuras', async () => {
      const pending = await prisma.outboxMessage.count({
        where: { bookingId: booking.id, publishedAt: null, rejectedAt: null },
      })
      return pending === 0
    })
    expect(
      await prisma.outboxMessage.count({
        where: { bookingId: booking.id, messageType: 'supplier.confirm' },
      }),
    ).toBe(1)
    expect(commandsFor(booking.id, 'supplier.confirm')).toHaveLength(1)
    expect(await prisma.consumedMessage.count({ where: { eventId } })).toBe(1)
  })

  test('alur bahagia: CONFIRMED, lalu voucher.generate di RabbitMQ', async () => {
    const booking = await paid()

    await events.publish('supplier.booking_confirmed', {
      bookingId: booking.id,
      supplier: 'SKY',
      supplierRef: 'SKY-IT-1',
      adopted: false,
    })

    await eventually(
      'voucher.generate tiba',
      () => commandsFor(booking.id, 'voucher.generate').length === 1,
    )
    expect(await status(booking.id)).toBe('CONFIRMED')
  })
})
