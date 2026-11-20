import {
  EVENT_PAYLOADS,
  EVENT_TYPES,
  type EventPayload,
  type EventType,
  type Message,
} from '@tbe/event-contracts'
import type { AnalyticsDeps } from '../application/ports.js'
import { recordEvent } from '../application/record-event.js'
import type { AnalyticsFact } from '../domain/facts.js'

/**
 * Consumer peristiwa analitik: SELURUH jenis peristiwa, dari seluruh topik.
 *
 * Inilah demonstrasi keunggulan Kafka yang diminta Step 27: service ini
 * ditambahkan tanpa satu baris pun berubah di service penerbit. Ia membaca
 * dengan consumer group-nya sendiri, jadi offset-nya terpisah dari group
 * booking-service, payment-service, dan notification-service — membaca
 * lambat, berhenti, atau diputar ulang dari awal tidak menggeser satu pesan
 * pun milik mereka.
 *
 * Aturan commit offset datang dari @tbe/messaging: basis data yang tidak dapat
 * dihubungi MELEMPAR, dan pesannya dibaca lagi. Pesan yang dibaca lagi setelah
 * tercatat ditolak sebagai duplikat oleh penyimpan.
 */

export const ANALYTICS_EVENTS = EVENT_TYPES

type AnyMessage = Message<EventType, EventPayload<EventType>>

export function handleAnalyticsEvent(deps: AnalyticsDeps) {
  return async (message: AnyMessage): Promise<void> => {
    const outcome = await recordEvent(deps, {
      eventId: message.eventId,
      occurrence: { occurredAt: message.occurredAt, eventType: message.eventType },
      fact: toFact(message),
    })
    deps.logger.debug(
      { eventId: message.eventId, eventType: message.eventType, outcome },
      'peristiwa analitik',
    )
  }
}

const OTHER: AnalyticsFact = { kind: 'other' }

/**
 * Satu penerjemah per jenis peristiwa, sebagai TABEL bertipe
 * `Record<EventType, ...>` — bukan switch dengan cabang `default`.
 * Jenis peristiwa baru di kontrak tanpa baris di sini gagal dikompilasi, jadi
 * tidak ada cabang "jenis tak dikenal" yang tidak pernah tercapai, dan tidak
 * ada penguraian dengan skema jenis yang salah.
 *
 * Setiap baris mengurai payload dengan skema JENISNYA SENDIRI, ditulis
 * eksplisit. Satu fungsi generik `EVENT_PAYLOADS[type].parse` tidak dapat
 * dibuktikan TypeScript cocok dengan penerjemah jenis yang sama (union yang
 * berkorelasi), dan jalan keluarnya hanya `as`. Pembungkus consumer sudah
 * memvalidasi seluruh pesan; penguraian kedua di sini menyempitkan tipe,
 * dengan jujur. Jenis yang hanya dihitung tidak mengurai apa pun.
 */
const FACTS: Readonly<Record<EventType, (raw: unknown) => AnalyticsFact>> = {
  'search.performed': (raw) => {
    const p = EVENT_PAYLOADS['search.performed'].parse(raw)
    return {
      kind: 'search',
      city: p.city,
      checkIn: p.checkIn,
      checkOut: p.checkOut,
      resultCount: p.resultCount,
      latencyMs: p.latencyMs,
      source: p.source,
      responded: p.suppliersResponded,
      timedOut: p.suppliersTimedOut,
      unavailable: p.suppliersUnavailable,
    }
  },
  'booking.created': (raw) => {
    const p = EVENT_PAYLOADS['booking.created'].parse(raw)
    return { kind: 'booking_created', bookingId: p.bookingId, supplier: p.supplier }
  },
  'booking.held': (raw) => ({
    kind: 'booking_held',
    bookingId: EVENT_PAYLOADS['booking.held'].parse(raw).bookingId,
  }),
  'booking.price_changed': (raw) => ({
    kind: 'price_changed',
    bookingId: EVENT_PAYLOADS['booking.price_changed'].parse(raw).bookingId,
  }),
  'booking.confirmed': (raw) => {
    const p = EVENT_PAYLOADS['booking.confirmed'].parse(raw)
    return { kind: 'booking_confirmed', bookingId: p.bookingId, supplier: p.supplier }
  },
  'booking.failed': (raw) => {
    const p = EVENT_PAYLOADS['booking.failed'].parse(raw)
    return {
      kind: 'booking_failed',
      bookingId: p.bookingId,
      stage: p.stage,
      reason: p.reason,
      requiresManualReview: p.requiresManualReview,
    }
  },
  'booking.cancelled': (raw) => {
    const p = EVENT_PAYLOADS['booking.cancelled'].parse(raw)
    return { kind: 'booking_cancelled', bookingId: p.bookingId, reason: p.reason }
  },
  'payment.succeeded': (raw) => ({
    kind: 'payment_succeeded',
    bookingId: EVENT_PAYLOADS['payment.succeeded'].parse(raw).bookingId,
  }),
  'payment.failed': (raw) => {
    const p = EVENT_PAYLOADS['payment.failed'].parse(raw)
    return { kind: 'payment_failed', bookingId: p.bookingId, reason: p.reason }
  },
  'payment.refunded': () => OTHER,
  'payment.refund_failed': () => OTHER,
  'supplier.degraded': (raw) => ({
    kind: 'supplier_degraded',
    supplier: EVENT_PAYLOADS['supplier.degraded'].parse(raw).supplier,
  }),
  'supplier.recovered': () => OTHER,
  'supplier.booking_confirmed': (raw) => ({
    kind: 'supplier_confirm',
    supplier: EVENT_PAYLOADS['supplier.booking_confirmed'].parse(raw).supplier,
    outcome: 'confirmed',
  }),
  'supplier.booking_rejected': (raw) => ({
    kind: 'supplier_confirm',
    supplier: EVENT_PAYLOADS['supplier.booking_rejected'].parse(raw).supplier,
    outcome: 'rejected',
  }),
  'supplier.booking_uncertain': (raw) => ({
    kind: 'supplier_confirm',
    supplier: EVENT_PAYLOADS['supplier.booking_uncertain'].parse(raw).supplier,
    outcome: 'uncertain',
  }),
  'supplier.booking_cancelled': () => OTHER,
  'supplier.booking_cancel_failed': () => OTHER,
  'voucher.issued': () => OTHER,
}

export function toFact(message: AnyMessage): AnalyticsFact {
  return FACTS[message.eventType](message.payload)
}
