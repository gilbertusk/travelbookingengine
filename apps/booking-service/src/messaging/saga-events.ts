import {
  EVENT_PAYLOADS,
  type EventPayload,
  type EventType,
  type Message,
} from '@tbe/event-contracts'
import { money, type MoneyJson } from '@tbe/money'
import type { BookingDeps } from '../application/ports.js'
import {
  onPaymentFailed,
  onPaymentRefunded,
  onPaymentSucceeded,
} from '../application/saga/on-payment.js'
import {
  onSupplierConfirmed,
  onSupplierRejected,
  onSupplierUncertain,
} from '../application/saga/on-supplier.js'
import type { Reaction } from '../application/saga/reaction.js'
import {
  onRefundFailed,
  onSupplierCancelFailed,
  onSupplierCancelled,
} from '../application/cancellation/on-replies.js'

/**
 * Consumer peristiwa saga (Step 19).
 *
 * Tidak ada keputusan di sini — seluruhnya di application/saga. Yang
 * dikerjakan berkas ini hanya menerjemahkan payload kontrak menjadi masukan
 * reaksi, dengan `eventId` amplop sebagai pengenal pesan terkonsumsi.
 *
 * Aturan commit offset datang dari @tbe/messaging: handler yang selesai tanpa
 * melempar berarti offset ter-commit; yang melempar berarti pesannya dibaca
 * lagi. Reaksi yang basis datanya sesaat tidak dapat dihubungi MELEMPAR, dan
 * itu benar — pesannya belum dikerjakan. Pesan yang sama yang dibaca lagi
 * SETELAH efeknya tersimpan ditolak catatan pesan terkonsumsi.
 */

export const SAGA_EVENTS = [
  'payment.succeeded',
  'payment.failed',
  'payment.refunded',
  'supplier.booking_confirmed',
  'supplier.booking_rejected',
  'supplier.booking_uncertain',
  // Step 25: jawaban atas pembatalan oleh pengguna.
  'supplier.booking_cancelled',
  'supplier.booking_cancel_failed',
  'payment.refund_failed',
] as const satisfies readonly EventType[]

type AnyMessage = Message<EventType, EventPayload<EventType>>

export function handleSagaEvent(deps: BookingDeps) {
  return async (message: AnyMessage): Promise<Reaction | 'not_subscribed'> => {
    const outcome = await dispatch(deps, message)
    deps.logger.debug(
      { eventId: message.eventId, eventType: message.eventType, outcome },
      'peristiwa saga diproses',
    )
    return outcome
  }
}

/**
 * Payload diurai ulang dengan skema kontraknya per jenis, bukan dipersempit
 * dengan `as`: `Message` bergeneral atas jenis DAN payload secara terpisah,
 * jadi menyempitkan `eventType` tidak menyempitkan payload-nya. Pembungkus
 * consumer sudah memvalidasinya; penguraian kedua murah dan membuat tipe di
 * bawah benar tanpa asersi.
 */
async function dispatch(
  deps: BookingDeps,
  message: AnyMessage,
): Promise<Reaction | 'not_subscribed'> {
  const eventId = message.eventId

  switch (message.eventType) {
    case 'payment.succeeded': {
      const payload = EVENT_PAYLOADS['payment.succeeded'].parse(message.payload)
      return await onPaymentSucceeded(deps, {
        eventId,
        ...payload,
        amount: moneyOf(payload.amount),
      })
    }
    case 'payment.failed': {
      const payload = EVENT_PAYLOADS['payment.failed'].parse(message.payload)
      return await onPaymentFailed(deps, { eventId, ...payload })
    }
    case 'payment.refunded': {
      const payload = EVENT_PAYLOADS['payment.refunded'].parse(message.payload)
      return await onPaymentRefunded(deps, { eventId, ...payload, amount: moneyOf(payload.amount) })
    }
    case 'supplier.booking_confirmed': {
      const payload = EVENT_PAYLOADS['supplier.booking_confirmed'].parse(message.payload)
      return await onSupplierConfirmed(deps, { eventId, ...payload })
    }
    case 'supplier.booking_rejected': {
      const payload = EVENT_PAYLOADS['supplier.booking_rejected'].parse(message.payload)
      return await onSupplierRejected(deps, { eventId, ...payload })
    }
    case 'supplier.booking_uncertain': {
      const payload = EVENT_PAYLOADS['supplier.booking_uncertain'].parse(message.payload)
      return await onSupplierUncertain(deps, { eventId, ...payload })
    }
    case 'supplier.booking_cancelled': {
      const payload = EVENT_PAYLOADS['supplier.booking_cancelled'].parse(message.payload)
      return await onSupplierCancelled(deps, { eventId, ...payload })
    }
    case 'supplier.booking_cancel_failed': {
      const payload = EVENT_PAYLOADS['supplier.booking_cancel_failed'].parse(message.payload)
      return await onSupplierCancelFailed(deps, { eventId, ...payload })
    }
    case 'payment.refund_failed': {
      const payload = EVENT_PAYLOADS['payment.refund_failed'].parse(message.payload)
      return await onRefundFailed(deps, { eventId, ...payload, amount: moneyOf(payload.amount) })
    }
    default:
      // Pembungkus consumer hanya meneruskan jenis yang diminta; ini sampai
      // di sini hanya bila SAGA_EVENTS dan switch di atas tidak sepakat.
      return 'not_subscribed'
  }
}

function moneyOf(json: MoneyJson) {
  return money(json.amountMinor, json.currency)
}
