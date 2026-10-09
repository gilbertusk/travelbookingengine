import { describe, expect, test } from 'vitest'
import { decide, fromCommand, type BookingFact, type FactMeta } from './policy.js'

const BOOKING = '018f2a1c-0000-7000-8000-00000000b001'
const USER = '7b9e2d14-1f3a-4e5c-8d6b-2a1c0f9e8d7c'
const REFUND = '018f2a1c-0000-7000-8000-0000000000r1'
const NOW = new Date('2026-10-08T10:00:00.000Z')
const MAX_AGE_MS = 48 * 3_600_000
const META: FactMeta = {
  messageId: 'evt-1',
  correlationId: 'corr-1',
  occurredAt: new Date('2026-10-08T09:59:58.000Z'),
}

function decideNow(fact: BookingFact, meta: FactMeta = META) {
  return decide(fact, meta, NOW, MAX_AGE_MS)
}

describe('kebijakan pemberitahuan', () => {
  test('booking.confirmed dan voucher.issued memicu SATU surel konfirmasi dengan kunci yang sama', () => {
    const confirmed = decideNow({ kind: 'booking_confirmed', bookingId: BOOKING })
    const issued = decideNow({ kind: 'voucher_issued', bookingId: BOOKING, userId: USER })

    expect(confirmed).toMatchObject({
      kind: 'notify',
      request: {
        dedupeKey: `booking_confirmed:${BOOKING}`,
        context: { type: 'booking_confirmed' },
      },
    })
    expect(issued).toMatchObject({
      kind: 'notify',
      request: { dedupeKey: `booking_confirmed:${BOOKING}`, userId: USER },
    })
  })

  test('kegagalan konfirmasi supplier menjadi surel kegagalan', () => {
    const decision = decideNow({
      kind: 'booking_failed',
      bookingId: BOOKING,
      stage: 'supplier_confirm',
      requiresManualReview: false,
    })

    expect(decision).toEqual({
      kind: 'notify',
      request: {
        bookingId: BOOKING,
        userId: null,
        dedupeKey: `booking_failed:${BOOKING}`,
        source: 'event',
        sourceMessageId: 'evt-1',
        correlationId: 'corr-1',
        context: { type: 'booking_failed' },
      },
    })
  })

  test('status supplier yang tidak pasti TIDAK dikabarkan sebagai kegagalan, melainkan pemeriksaan kamar', () => {
    const decision = decideNow({
      kind: 'booking_failed',
      bookingId: BOOKING,
      stage: 'supplier_confirm',
      requiresManualReview: true,
    })

    expect(decision).toMatchObject({
      request: {
        dedupeKey: `manual_review:${BOOKING}`,
        context: { type: 'manual_review', concern: 'room' },
      },
    })
  })

  test('refund yang gagal menjadi pemeriksaan pengembalian dana', () => {
    const decision = decideNow({
      kind: 'booking_failed',
      bookingId: BOOKING,
      stage: 'payment',
      requiresManualReview: true,
    })

    expect(decision).toMatchObject({
      request: { context: { type: 'manual_review', concern: 'refund' } },
    })
  })

  test('refund pembatalan oleh pengguna yang gagal menjadi pemeriksaan pembatalan (Step 25)', () => {
    const decision = decideNow({
      kind: 'booking_failed',
      bookingId: BOOKING,
      stage: 'cancellation',
      requiresManualReview: true,
    })

    expect(decision).toMatchObject({
      request: { context: { type: 'manual_review', concern: 'cancellation' } },
    })
  })

  test('pembatalan membawa alasan dan nilai pengembaliannya', () => {
    const refund = { amountMinor: 1_221_000, currency: 'IDR' } as const

    const decision = decideNow({
      kind: 'booking_cancelled',
      bookingId: BOOKING,
      reason: 'user_request',
      refundAmount: refund,
    })

    expect(decision).toMatchObject({
      request: {
        dedupeKey: `booking_cancelled:${BOOKING}`,
        context: { type: 'booking_cancelled', reason: 'user_request', refund },
      },
    })
  })

  test('hold yang kedaluwarsa tidak dikabarkan: belum ada yang dibayar', () => {
    const decision = decideNow({
      kind: 'booking_cancelled',
      bookingId: BOOKING,
      reason: 'hold_expired',
      refundAmount: null,
    })

    expect(decision).toEqual({ kind: 'skip', reason: 'hold_expired' })
  })

  test('setiap refund dikabarkan sendiri, dikunci pengenal refund', () => {
    const amount = { amountMinor: 2_442_000, currency: 'IDR' } as const

    const decision = decideNow({
      kind: 'payment_refunded',
      bookingId: BOOKING,
      refundId: REFUND,
      amount,
    })

    expect(decision).toMatchObject({
      request: {
        dedupeKey: `refund_completed:${BOOKING}:${REFUND}`,
        context: { type: 'refund_completed', amount },
      },
    })
  })

  test('peristiwa yang lebih tua dari batas umur dilewati', () => {
    const old = { ...META, occurredAt: new Date(NOW.getTime() - MAX_AGE_MS - 1) }

    expect(decideNow({ kind: 'booking_confirmed', bookingId: BOOKING }, old)).toEqual({
      kind: 'skip',
      reason: 'stale',
    })
  })

  test('peristiwa tepat di batas umur masih dikabarkan', () => {
    const edge = { ...META, occurredAt: new Date(NOW.getTime() - MAX_AGE_MS) }

    expect(decideNow({ kind: 'booking_confirmed', bookingId: BOOKING }, edge).kind).toBe('notify')
  })
})

describe('permintaan dari perintah', () => {
  test('dikunci eventId perintahnya, bukan jenis surelnya', () => {
    const request = fromCommand({
      commandId: 'cmd-1',
      correlationId: 'corr-9',
      bookingId: BOOKING,
      userId: USER,
      template: 'booking_confirmed',
    })

    expect(request).toEqual({
      bookingId: BOOKING,
      userId: USER,
      dedupeKey: 'command:cmd-1',
      source: 'command',
      sourceMessageId: 'cmd-1',
      correlationId: 'corr-9',
      context: { type: 'booking_confirmed' },
    })
  })

  test.each([
    ['booking_failed', { type: 'booking_failed' }],
    ['manual_review', { type: 'manual_review', concern: 'unspecified' }],
    ['booking_cancelled', { type: 'booking_cancelled', reason: 'unspecified', refund: null }],
    ['refund_completed', { type: 'refund_completed', amount: null }],
  ] as const)('template %s memakai konteks umum', (template, context) => {
    expect(
      fromCommand({
        commandId: 'c',
        correlationId: 'k',
        bookingId: BOOKING,
        userId: USER,
        template,
      }).context,
    ).toEqual(context)
  })
})
