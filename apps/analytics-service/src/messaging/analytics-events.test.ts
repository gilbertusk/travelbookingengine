import { EVENT_TYPES, type EventType } from '@tbe/event-contracts'
import { createEventConsumer } from '@tbe/messaging'
import { describe, expect, test } from 'vitest'
import { deadLetterObserver } from '../infrastructure/dead-letter-observer.js'
import { sampleMessage } from '../testing/events.js'
import { deps, memoryStore, silentLogger } from '../testing/fakes.js'
import { ANALYTICS_EVENTS, handleAnalyticsEvent, toFact } from './analytics-events.js'

describe('toFact', () => {
  test('setiap jenis peristiwa di kontrak berlangganan dan diterjemahkan', () => {
    expect([...ANALYTICS_EVENTS]).toEqual([...EVENT_TYPES])

    const kinds = Object.fromEntries(
      EVENT_TYPES.map((type) => [type, toFact(sampleMessage(type)).kind]),
    )
    expect(kinds).toEqual({
      'search.performed': 'search',
      'booking.created': 'booking_created',
      'booking.held': 'booking_held',
      'booking.price_changed': 'price_changed',
      'booking.confirmed': 'booking_confirmed',
      'booking.failed': 'booking_failed',
      'booking.cancelled': 'booking_cancelled',
      'payment.succeeded': 'payment_succeeded',
      'payment.failed': 'payment_failed',
      'payment.refunded': 'other',
      'payment.refund_failed': 'other',
      'supplier.degraded': 'supplier_degraded',
      'supplier.recovered': 'other',
      'supplier.booking_confirmed': 'supplier_confirm',
      'supplier.booking_rejected': 'supplier_confirm',
      'supplier.booking_uncertain': 'supplier_confirm',
      'supplier.booking_cancelled': 'other',
      'supplier.booking_cancel_failed': 'other',
      'voucher.issued': 'other',
    } satisfies Record<EventType, string>)
  })

  test('hasil konfirmasi supplier dipetakan ke tiga hasilnya', () => {
    expect(toFact(sampleMessage('supplier.booking_rejected'))).toEqual({
      kind: 'supplier_confirm',
      supplier: 'SKY',
      outcome: 'rejected',
    })
  })
})

describe('jalur consumer lengkap (pembungkus @tbe/messaging + handler analitik)', () => {
  function consumer(store = memoryStore(), observed: string[] = []) {
    return createEventConsumer({
      subscribedTo: ANALYTICS_EVENTS,
      producer: deadLetterObserver(silentLogger(), (topic) => observed.push(topic)),
      logger: silentLogger(),
      handle: handleAnalyticsEvent(deps(store)),
    })
  }

  const incoming = (value: string | null) => ({
    topic: 'tbe.booking.v1',
    partition: 0,
    value: value === null ? null : Buffer.from(value),
    headers: {},
  })

  test('pesan sah tercatat; pesan yang sama lagi tidak menambah apa pun', async () => {
    const store = memoryStore()
    const message = JSON.stringify(sampleMessage('booking.held'))

    await consumer(store)(incoming(message))
    await consumer(store)(incoming(message))

    expect(await store.processedCount()).toBe(1)
  })

  test('pesan cacat: dilewati tanpa melempar dan tanpa MENULIS ke dead letter', async () => {
    // Pengamat menggantikan produsen; bila pembungkus memanggil send, itu
    // tercatat di sini — dan tidak satu byte pun keluar ke Kafka.
    const observed: string[] = []

    await consumer(memoryStore(), observed)(incoming('{bukan json'))
    await consumer(memoryStore(), observed)(incoming(null))

    expect(observed).toEqual(['tbe.dead-letter.v1', 'tbe.dead-letter.v1'])
  })
})
