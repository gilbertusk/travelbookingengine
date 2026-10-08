import {
  EVENT_PAYLOADS,
  type EventPayload,
  type EventType,
  type Message,
} from '@tbe/event-contracts'
import type { NotificationDeps } from '../application/ports.js'
import { decide, type BookingFact } from '../domain/policy.js'

/**
 * Consumer peristiwa Kafka: jalur KEPUTUSAN.
 *
 * Penerbit peristiwa tidak meminta surel apa pun; mereka hanya mengumumkan
 * fakta. Service ini membaca fakta itu dan memutuskan sendiri — lewat
 * domain/policy.ts — apakah pengguna perlu tahu (ADR-0003).
 *
 * Handler hanya MENCATAT pemberitahuan, satu tulisan ke basis data, lalu
 * membangunkan penghantar. Ia tidak menunggu surel terkirim: SMTP yang mati
 * tidak boleh menahan partisi, dan partisi yang tertahan menahan setiap
 * peristiwa pemesanan lain di belakangnya (NFR-05).
 *
 * Aturan commit offset datang dari @tbe/messaging. Basis data yang tidak
 * dapat dihubungi MELEMPAR — pesannya belum dicatat, jadi harus dibaca lagi.
 * Pesan yang dibaca lagi SETELAH tercatat ditolak batasan UNIK dedupe_key.
 */

export const NOTIFICATION_EVENTS = [
  'booking.confirmed',
  'booking.failed',
  'booking.cancelled',
  'payment.refunded',
  'voucher.issued',
] as const satisfies readonly EventType[]

type AnyMessage = Message<EventType, EventPayload<EventType>>

export interface EventHandlerSettings {
  readonly maxEventAgeMs: number
  /** Membangunkan penghantar supaya surel tidak menunggu putaran berikutnya. */
  readonly wake: () => void
}

export function handleNotificationEvent(deps: NotificationDeps, settings: EventHandlerSettings) {
  return async (message: AnyMessage): Promise<void> => {
    const fact = toFact(message)
    if (fact === undefined) return

    const meta = {
      messageId: message.eventId,
      correlationId: message.correlationId,
      occurredAt: new Date(message.occurredAt),
    }
    const decision = decide(fact, meta, deps.clock.now(), settings.maxEventAgeMs)
    if (decision.kind === 'skip') {
      deps.logger.debug(
        { eventId: message.eventId, eventType: message.eventType, reason: decision.reason },
        'peristiwa tidak memerlukan pemberitahuan',
      )
      return
    }

    const outcome = await deps.notifications.request(decision.request, deps.clock.now())
    settings.wake()
    deps.logger.info(
      {
        eventId: message.eventId,
        eventType: message.eventType,
        bookingId: decision.request.bookingId,
        type: decision.request.context.type,
        outcome: outcome.kind,
      },
      'pemberitahuan dicatat dari peristiwa',
    )
  }
}

/**
 * Payload diurai ulang per jenis dengan skema kontraknya — pola yang sama
 * dengan consumer saga di booking-service: menyempitkan `eventType` tidak
 * menyempitkan payload, dan penguraian kedua lebih jujur daripada `as`.
 */
function toFact(message: AnyMessage): BookingFact | undefined {
  switch (message.eventType) {
    case 'booking.confirmed': {
      const payload = EVENT_PAYLOADS['booking.confirmed'].parse(message.payload)
      return { kind: 'booking_confirmed', bookingId: payload.bookingId }
    }
    case 'voucher.issued': {
      const payload = EVENT_PAYLOADS['voucher.issued'].parse(message.payload)
      return { kind: 'voucher_issued', bookingId: payload.bookingId, userId: payload.userId }
    }
    case 'booking.failed': {
      const payload = EVENT_PAYLOADS['booking.failed'].parse(message.payload)
      return {
        kind: 'booking_failed',
        bookingId: payload.bookingId,
        stage: payload.stage,
        requiresManualReview: payload.requiresManualReview,
      }
    }
    case 'booking.cancelled': {
      const payload = EVENT_PAYLOADS['booking.cancelled'].parse(message.payload)
      return {
        kind: 'booking_cancelled',
        bookingId: payload.bookingId,
        reason: payload.reason,
        refundAmount: payload.refundAmount ?? null,
      }
    }
    case 'payment.refunded': {
      const payload = EVENT_PAYLOADS['payment.refunded'].parse(message.payload)
      return {
        kind: 'payment_refunded',
        bookingId: payload.bookingId,
        refundId: payload.refundId,
        amount: payload.amount,
      }
    }
    default:
      // Pembungkus consumer hanya meneruskan jenis yang diminta; ini sampai
      // di sini hanya bila NOTIFICATION_EVENTS dan switch di atas tidak sepakat.
      return undefined
  }
}
