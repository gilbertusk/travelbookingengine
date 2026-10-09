import { toJson } from '@tbe/money'
import type { NotCancellableReason } from '../application/cancellation/assess.js'
import type { Booking } from '../domain/booking.js'
import type { RefundQuote } from '../domain/refund-schedule.js'

/**
 * Bentuk pratinjau pembatalan untuk klien (Step 25).
 *
 * Setiap tenggat dinyatakan sebagai TITIK WAKTU (ISO, UTC) bersama zona waktu
 * properti tempat tenggat itu dihitung — bukan sebagai "3 hari lagi". Klien
 * menampilkannya sebagai tanggal dan jam konkret di zona properti (Step 26),
 * dan pengguna di Jakarta yang memesan hotel di Tokyo melihat tenggat yang
 * sama dengan yang dipakai sistem.
 */
export function quoteView(quote: RefundQuote) {
  return {
    refund: toJson(quote.refund),
    percent: quote.percent,
    until: quote.until.toISOString(),
    next: quote.next ?? null,
    nothingBack: nothingBackView(quote.nothingBack),
    tiers: quote.tiers.map((tier) => ({ percent: tier.percent, until: tier.until.toISOString() })),
    checkInStartsAt: quote.checkInStartsAt.toISOString(),
    timeZone: quote.timeZone,
  }
}

function nothingBackView(reason: RefundQuote['nothingBack']) {
  if (reason === undefined) return null
  if (reason.kind === 'non_refundable') return { kind: reason.kind }

  return {
    kind: reason.kind,
    lastRefund: {
      percent: reason.lastRefund.percent,
      until: reason.lastRefund.until.toISOString(),
    },
  }
}

export function cancellablePreviewView(booking: Booking, quote: RefundQuote, now: Date) {
  return {
    bookingId: booking.id,
    cancellable: true as const,
    paid: toJson(booking.price.total),
    quote: quoteView(quote),
    serverTime: now.toISOString(),
  }
}

/** Kalimat untuk setiap alasan, supaya klien yang belum mengenal kodenya tetap jujur. */
const REASON_MESSAGES: Readonly<Record<NotCancellableReason, string>> = {
  not_confirmed: 'Pemesanan ini belum terkonfirmasi, jadi belum ada yang dapat dibatalkan.',
  in_progress: 'Pembatalan pemesanan ini sedang diproses.',
  already_cancelled: 'Pemesanan ini sudah dibatalkan.',
  stay_started: 'Tanggal masuk sudah tiba di properti. Pembatalan tidak lagi dapat dilakukan.',
  policy_unknown:
    'Kebijakan pembatalan pemesanan ini tidak tercatat. Hubungi kami untuk membatalkannya.',
  time_zone_unknown:
    'Tenggat pembatalan pemesanan ini belum dapat dihitung. Hubungi kami untuk membatalkannya.',
}

export function notCancellableMessage(reason: NotCancellableReason): string {
  return REASON_MESSAGES[reason]
}

export function notCancellableView(bookingId: string, reason: NotCancellableReason, now: Date) {
  return {
    bookingId,
    cancellable: false as const,
    reason,
    message: notCancellableMessage(reason),
    serverTime: now.toISOString(),
  }
}

/**
 * Pembatalan dalam status pemesanan. `step`: `supplier` dan `refund` selama
 * berjalan, `done` setelah tuntas. Pembatalan yang diserahkan ke manusia
 * terlihat dari status NEEDS_REVIEW dan `refund: 'review'`, bukan dari sini.
 */
export function cancellationView(booking: Booking) {
  const request = booking.cancellationRequest
  if (request === undefined) return null

  return {
    step: booking.cancellationStage?.step ?? 'done',
    refund: toJson(request.refund),
    percent: request.percent,
    requestedAt: request.requestedAt.toISOString(),
  }
}
