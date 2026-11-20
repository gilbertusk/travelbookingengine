import {
  createMessage,
  type EventPayload,
  type EventType,
  type Message,
} from '@tbe/event-contracts'

/**
 * Satu contoh payload yang SAH untuk setiap jenis peristiwa di kontrak.
 *
 * Bertipe `{ [T in EventType]: EventPayload<T> }`: jenis peristiwa baru di
 * packages/event-contracts tanpa contoh di sini gagal dikompilasi, jadi uji
 * "seluruh topik dibaca" tidak dapat diam-diam tertinggal dari kontrak.
 * Dipakai uji unit DAN uji integrasi, yang menerbitkannya ke Kafka sungguhan.
 */

export const BOOKING_A = '3f0c8a52-6d1e-4c3b-9a7f-0e1d2c3b4a59'
const PAYMENT = 'c2d4e6f8-0a1b-4c3d-8e5f-6a7b8c9d0e1f'
const REFUND = 'e1f2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a5b'
const USER = '7b9e2d14-1f3a-4e5c-8d6b-2a1c0f9e8d7c'
const IDR = (amountMinor: number) => ({ amountMinor, currency: 'IDR' as const })

type Payloads = { readonly [T in EventType]: EventPayload<T> }
type Family<P extends string> = Pick<Payloads, Extract<EventType, `${P}.${string}`>>

export function samplePayloads(bookingId = BOOKING_A): Payloads {
  return {
    'search.performed': {
      city: 'Bali',
      checkIn: '2026-11-10',
      checkOut: '2026-11-12',
      guests: 2,
      resultCount: 24,
      latencyMs: 640,
      source: 'live',
      suppliersResponded: ['SKY', 'NOVA', 'ORBIT'],
      suppliersTimedOut: ['LUNA'],
      suppliersUnavailable: ['ZEPH'],
    },
    ...bookingPayloads(bookingId),
    ...paymentPayloads(bookingId),
    ...supplierPayloads(bookingId),
    'voucher.issued': {
      bookingId,
      voucherId: REFUND,
      userId: USER,
      issuedAt: '2026-10-25T03:20:00.000Z',
      latencyMs: 1_200,
    },
  }
}

function bookingPayloads(bookingId: string): Family<'booking'> {
  return {
    'booking.created': {
      bookingId,
      userId: USER,
      supplier: 'SKY',
      propertyId: 'prop-1',
      ratePlanRef: 'rp-1',
      checkIn: '2026-11-10',
      checkOut: '2026-11-12',
      guests: 2,
      amount: IDR(2_442_000),
    },
    'booking.held': { bookingId, holdRef: 'hold-1', expiresAt: '2026-10-25T03:15:00.000Z' },
    'booking.price_changed': {
      bookingId,
      previousAmount: IDR(2_442_000),
      newAmount: IDR(2_500_000),
    },
    'booking.confirmed': { bookingId, supplier: 'SKY', supplierRef: 'SKY-BK-1' },
    'booking.failed': {
      bookingId,
      stage: 'supplier_confirm',
      reason: 'sold_out',
      requiresManualReview: false,
    },
    'booking.cancelled': { bookingId, reason: 'user_request', refundAmount: IDR(1_000_000) },
  }
}

function paymentPayloads(bookingId: string): Family<'payment'> {
  const amount = IDR(2_442_000)
  return {
    'payment.succeeded': { paymentId: PAYMENT, bookingId, amount, gatewayRef: 'mt-1' },
    'payment.failed': { paymentId: PAYMENT, bookingId, reason: 'card_declined' },
    'payment.refunded': { refundId: REFUND, paymentId: PAYMENT, bookingId, amount },
    'payment.refund_failed': {
      refundRequestId: REFUND,
      paymentId: PAYMENT,
      bookingId,
      amount,
      reason: 'gateway_rejected',
    },
  }
}

function supplierPayloads(bookingId: string): Family<'supplier'> {
  const ref = { bookingId, supplier: 'SKY', supplierRef: 'SKY-BK-1' } as const
  return {
    'supplier.degraded': { supplier: 'LUNA', circuitState: 'open', reason: 'timeout' },
    'supplier.recovered': { supplier: 'LUNA' },
    'supplier.booking_confirmed': { ...ref, adopted: false },
    'supplier.booking_rejected': { bookingId, supplier: 'SKY', reason: 'sold_out' },
    'supplier.booking_uncertain': {
      bookingId,
      supplier: 'SKY',
      idempotencyKey: bookingId,
      reason: 'timeout',
    },
    'supplier.booking_cancelled': ref,
    'supplier.booking_cancel_failed': { ...ref, outcome: 'refused', reason: 'upstream_error:409' },
  }
}

export function sampleMessage<T extends EventType>(
  type: T,
  options: { readonly bookingId?: string; readonly eventId?: string } = {},
): Message<T, EventPayload<T>> {
  return createMessage({
    eventType: type,
    payload: samplePayloads(options.bookingId)[type],
    occurredAt: '2026-10-25T03:00:00.000Z',
    correlationId: 'it-analytics',
    ...(options.eventId === undefined ? {} : { eventId: options.eventId }),
  })
}
