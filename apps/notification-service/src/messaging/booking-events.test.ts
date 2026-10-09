import { createMessage, type EventPayload, type EventType } from '@tbe/event-contracts'
import { createEventConsumer, type KafkaRecord } from '@tbe/messaging'
import { describe, expect, test } from 'vitest'
import { deliverDue } from '../application/deliver.js'
import { BOOKING_ID, START, USER, snapshot, world, type World } from '../testing/fakes.js'
import { NOTIFICATION_EVENTS, handleNotificationEvent } from './booking-events.js'

/**
 * Lewat pembungkus consumer @tbe/messaging yang SAMA dengan produksi:
 * pesan diurai dari byte, divalidasi kontraknya, lalu sampai ke handler.
 */

const MAX_AGE_MS = 48 * 3_600_000

interface Harness {
  readonly w: World
  readonly wakes: { count: number }
  readonly deadLetters: KafkaRecord[]
  deliver(
    type: EventType,
    payload: unknown,
    overrides?: { eventId?: string; occurredAt?: string },
  ): Promise<void>
}

function harness(w: World = world()): Harness {
  const wakes = { count: 0 }
  const deadLetters: KafkaRecord[] = []
  const consumer = createEventConsumer({
    subscribedTo: NOTIFICATION_EVENTS,
    producer: {
      async send(_topic, records) {
        deadLetters.push(...records)
        await Promise.resolve()
      },
    },
    logger: w.deps.logger,
    handle: handleNotificationEvent(w.deps, {
      maxEventAgeMs: MAX_AGE_MS,
      wake: () => {
        wakes.count += 1
      },
    }),
  })

  return {
    w,
    wakes,
    deadLetters,
    async deliver(type, payload, overrides = {}) {
      const message = createMessage({
        eventType: type,
        payload,
        correlationId: 'corr-1',
        occurredAt: overrides.occurredAt ?? START.toISOString(),
        ...(overrides.eventId === undefined ? {} : { eventId: overrides.eventId }),
      })
      await consumer({
        topic: 'tbe.booking.v1',
        partition: 0,
        value: Buffer.from(JSON.stringify(message)),
        headers: {},
      })
    },
  }
}

const failed: EventPayload<'booking.failed'> = {
  bookingId: BOOKING_ID,
  stage: 'supplier_confirm',
  reason: 'kamar habis',
  requiresManualReview: false,
}

describe('consumer peristiwa Kafka', () => {
  test('peristiwa yang sama dua kali menghasilkan SATU surel', async () => {
    const h = harness(world({ snapshots: [snapshot({ status: 'FAILED' })] }))
    const eventId = '018f2a1c-0000-7000-8000-0000000e0001'

    await h.deliver('booking.failed', failed, { eventId })
    await h.deliver('booking.failed', failed, { eventId })
    await deliverDue(h.w.deps)
    await deliverDue(h.w.deps)

    expect(h.w.notifications.rows).toHaveLength(1)
    expect(h.w.sender.sent).toHaveLength(1)
  })

  test('voucher.issued yang diterbitkan ulang dengan eventId berbeda tetap satu surel konfirmasi', async () => {
    const h = harness()
    const issued: EventPayload<'voucher.issued'> = {
      bookingId: BOOKING_ID,
      voucherId: '018f2a1c-0000-7000-8000-0000000000a2',
      userId: USER,
      issuedAt: START.toISOString(),
      latencyMs: 4_000,
    }

    await h.deliver('booking.confirmed', {
      bookingId: BOOKING_ID,
      supplier: 'SKY',
      supplierRef: 'SKY-1',
    })
    await h.deliver('voucher.issued', issued)
    await h.deliver('voucher.issued', issued)
    await deliverDue(h.w.deps)

    expect(h.w.sender.sent).toHaveLength(1)
    expect(h.w.sender.sent[0]?.attachments).toHaveLength(1)
  })

  test('voucher.issued memajukan surel konfirmasi yang sedang menunggu vouchernya', async () => {
    const h = harness(world({ voucherReady: false }))
    await h.deliver('booking.confirmed', {
      bookingId: BOOKING_ID,
      supplier: 'SKY',
      supplierRef: 'SKY-1',
    })
    await deliverDue(h.w.deps)
    expect(h.w.notifications.rows[0]?.status).toBe('PENDING')

    h.w.advance(1_000)
    h.w.vouchers.documents.set(BOOKING_ID, new Uint8Array([1]))
    await h.deliver('voucher.issued', {
      bookingId: BOOKING_ID,
      voucherId: '018f2a1c-0000-7000-8000-0000000000a1',
      userId: USER,
      issuedAt: START.toISOString(),
      latencyMs: 1_000,
    })
    await deliverDue(h.w.deps)

    expect(h.w.sender.sent).toHaveLength(1)
  })

  test('kegagalan pengiriman tidak memengaruhi pemesanan: handler selesai, booking-service hanya dibaca', async () => {
    const h = harness(world({ snapshots: [snapshot({ status: 'FAILED' })] }))
    h.w.sender.throwing = true

    await expect(h.deliver('booking.failed', failed)).resolves.toBeUndefined()
    await deliverDue(h.w.deps)

    // Satu-satunya jalan ke booking-service adalah port baca. Tidak ada
    // perintah, tidak ada peristiwa, tidak ada tulisan ke arah pemesanan.
    expect(
      Object.keys(h.w.bookings).filter(
        (key) => typeof Reflect.get(h.w.bookings, key) === 'function',
      ),
    ).toEqual(['notificationSource'])
    expect(h.w.notifications.rows[0]?.status).toBe('PENDING')
    expect(h.deadLetters).toEqual([])
  })

  test('penghantar dibangunkan sesudah pemberitahuan dicatat', async () => {
    const h = harness()

    await h.deliver('booking.confirmed', {
      bookingId: BOOKING_ID,
      supplier: 'SKY',
      supplierRef: 'SKY-1',
    })

    expect(h.wakes.count).toBe(1)
  })

  test('hold yang kedaluwarsa tidak dicatat sama sekali', async () => {
    const h = harness()

    await h.deliver('booking.cancelled', { bookingId: BOOKING_ID, reason: 'hold_expired' })

    expect(h.w.notifications.rows).toEqual([])
    expect(h.wakes.count).toBe(0)
  })

  test('peristiwa lama dari awal topik tidak dikirimi surel', async () => {
    const h = harness()

    await h.deliver(
      'booking.confirmed',
      { bookingId: BOOKING_ID, supplier: 'SKY', supplierRef: 'SKY-1' },
      { occurredAt: new Date(START.getTime() - MAX_AGE_MS - 1).toISOString() },
    )

    expect(h.w.notifications.rows).toEqual([])
  })

  test('pembatalan dan refund diteruskan bersama nilai uangnya', async () => {
    const h = harness()
    const refundAmount = { amountMinor: 1_221_000, currency: 'IDR' } as const

    await h.deliver('booking.cancelled', {
      bookingId: BOOKING_ID,
      reason: 'user_request',
      refundAmount,
    })
    await h.deliver('payment.refunded', {
      refundId: '018f2a1c-0000-7000-8000-0000000000f1',
      paymentId: '018f2a1c-0000-7000-8000-0000000000f2',
      bookingId: BOOKING_ID,
      amount: refundAmount,
    })

    expect(h.w.notifications.rows.map((row) => row.request.context)).toEqual([
      { type: 'booking_cancelled', reason: 'user_request', refund: refundAmount },
      { type: 'refund_completed', amount: refundAmount },
    ])
  })

  test('pembatalan tanpa nilai pengembalian dicatat dengan nilai kosong', async () => {
    const h = harness()

    await h.deliver('booking.cancelled', { bookingId: BOOKING_ID, reason: 'payment_failed' })

    expect(h.w.notifications.rows[0]?.request.context).toEqual({
      type: 'booking_cancelled',
      reason: 'payment_failed',
      refund: null,
    })
  })

  test('basis data yang mati MELEMPAR, supaya offset tidak ter-commit dan pesannya dibaca lagi', async () => {
    const h = harness()
    h.w.notifications.failNext = true

    await expect(
      h.deliver('booking.confirmed', {
        bookingId: BOOKING_ID,
        supplier: 'SKY',
        supplierRef: 'SKY-1',
      }),
    ).rejects.toThrow()
  })

  test('peristiwa yang tidak dibaca service ini dilewati tanpa suara', async () => {
    const h = harness()

    await h.deliver('booking.held', {
      bookingId: BOOKING_ID,
      holdRef: 'H-1',
      expiresAt: START.toISOString(),
    })

    expect(h.w.notifications.rows).toEqual([])
    expect(h.deadLetters).toEqual([])
  })
})
