import type { EventPayload } from '@tbe/event-contracts'
import { toJson } from '@tbe/money'
import type { BookingCreated, BookingEvent, ReviewRequired } from '../domain/events.js'

/**
 * Pemetaan peristiwa domain ke payload kontrak peristiwa Kafka.
 *
 * Hanya PAYLOAD — bukan amplop, bukan penerbitan. Step 16 tidak punya Kafka
 * sama sekali; penerbitan lewat outbox adalah jatah Step 19. Pemetaan ini ada
 * sekarang karena satu alasan: membuktikan bahwa peristiwa domain membawa
 * seluruh yang dituntut kontraknya. payment-service (Step 18) sudah berjalan
 * dan menunggu `booking.created` dan `booking.price_changed` untuk mengetahui
 * nilai yang boleh ditagih. Bidang yang terlupa di peristiwa domain baru akan
 * ketahuan saat outbox pertama diterbitkan — kecuali ada uji yang mengurai hasil
 * pemetaan ini dengan skema kontraknya, dan uji itu ada di
 * contract-payloads.test.ts.
 *
 * Tidak setiap peristiwa domain punya pasangan. PriceVerified, PriceAccepted,
 * PaymentRecorded, dan BookingRefunded adalah catatan audit internal: fakta
 * pembayaran dan refund diumumkan payment-service sendiri, dan persetujuan
 * harga tidak mengubah apa pun yang dibaca service lain.
 */

export type ContractEvent = {
  readonly [T in ContractType]: { readonly type: T; readonly payload: EventPayload<T> }
}[ContractType]

type ContractType =
  | 'booking.created'
  | 'booking.price_changed'
  | 'booking.held'
  | 'booking.confirmed'
  | 'booking.failed'
  | 'booking.cancelled'

export function toContractEvent(event: BookingEvent): ContractEvent | undefined {
  const bookingId = event.bookingId

  switch (event.type) {
    case 'BookingCreated':
      return { type: 'booking.created', payload: createdPayload(event) }
    case 'PriceChanged':
      return {
        type: 'booking.price_changed',
        payload: {
          bookingId,
          previousAmount: toJson(event.previousAmount),
          newAmount: toJson(event.newAmount),
        },
      }
    case 'BookingHeld':
      return {
        type: 'booking.held',
        payload: { bookingId, holdRef: event.holdRef, expiresAt: event.heldUntil.toISOString() },
      }
    case 'BookingConfirmed':
      return {
        type: 'booking.confirmed',
        payload: { bookingId, supplier: event.supplier, supplierRef: event.supplierRef },
      }
    case 'BookingFailed':
    case 'ReviewRequired':
      return { type: 'booking.failed', payload: failedPayload(event) }
    case 'BookingCancelled':
      return { type: 'booking.cancelled', payload: { bookingId, reason: event.reason } }
    case 'CancellationCompleted':
      // Pembatalan oleh pengguna setelah terkonfirmasi (Step 25). Nilainya
      // selalu disertakan, juga nol: notification-service membedakan "tidak ada
      // yang kembali sesuai kebijakan" dari "rincian menyusul" lewat ada
      // tidaknya bidang ini.
      return {
        type: 'booking.cancelled',
        payload: { bookingId, reason: 'user_request', refundAmount: toJson(event.refund) },
      }
    case 'HoldExpired':
      // EXPIRED adalah keadaannya sendiri di domain, tetapi bagi service lain
      // ia pembatalan dengan alasan `hold_expired` — dan kontraknya memang
      // menyatakannya begitu sejak Step 05.
      return { type: 'booking.cancelled', payload: { bookingId, reason: 'hold_expired' } }
    // Langkah tengah pembatalan (tiga terakhir) adalah urusan saga ini sendiri.
    // Yang diumumkan hanyalah akhirnya: dibatalkan, atau diserahkan ke manusia.
    case 'PriceVerified':
    case 'PriceAccepted':
    case 'PaymentRecorded':
    case 'BookingRefunded':
    case 'CancellationRequested':
    case 'SupplierCancellationConfirmed':
    case 'CancellationRestored':
      return undefined
  }
}

/**
 * `booking.created`. Tanggal menginap diteruskan apa adanya sebagai tanggal
 * kalender — kontraknya menolak apa pun selain `YYYY-MM-DD`.
 */
function createdPayload(event: BookingCreated): EventPayload<'booking.created'> {
  return {
    bookingId: event.bookingId,
    userId: event.userId,
    supplier: event.supplier,
    propertyId: event.propertyId,
    ratePlanRef: event.ratePlanRef,
    checkIn: event.stay.checkIn,
    checkOut: event.stay.checkOut,
    guests: event.guestCount,
    amount: toJson(event.amount),
  }
}

/**
 * `booking.failed` untuk dua peristiwa domain.
 *
 * - BookingFailed: konfirmasi supplier gagal permanen setelah uang diterima —
 *   satu-satunya jalan ke FAILED — jadi tahapnya `supplier_confirm`, dan
 *   kompensasinya otomatis.
 * - ReviewRequired dari PAID: status supplier tidak dapat dipastikan (US-05).
 *   Dari FAILED: kompensasinya — refund — yang gagal, jadi tahapnya `payment`.
 *   Dari CANCELLING (Step 25): refund pembatalan oleh pengguna yang gagal atau
 *   tidak terjawab, jadi tahapnya `cancellation` — kamarnya mungkin sudah
 *   lepas, dan surelnya tidak boleh berkata "belum terkonfirmasi".
 *   Ketiganya `requiresManualReview`.
 */
const REVIEW_STAGES = {
  PAID: 'supplier_confirm',
  FAILED: 'payment',
  CANCELLING: 'cancellation',
} as const satisfies Record<ReviewRequired['from'], EventPayload<'booking.failed'>['stage']>

function failedPayload(
  event: Extract<BookingEvent, { type: 'BookingFailed' | 'ReviewRequired' }>,
): EventPayload<'booking.failed'> {
  if (event.type === 'BookingFailed') {
    return {
      bookingId: event.bookingId,
      stage: 'supplier_confirm',
      reason: event.reason,
      requiresManualReview: false,
    }
  }

  return {
    bookingId: event.bookingId,
    stage: REVIEW_STAGES[event.from],
    reason: event.reason,
    requiresManualReview: true,
  }
}
