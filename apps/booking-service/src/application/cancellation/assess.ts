import type { Booking, BookingIn } from '../../domain/booking.js'
import { quoteRefund, type RefundQuote } from '../../domain/refund-schedule.js'
import type { BookingDeps } from '../ports.js'

/**
 * Apakah pemesanan ini dapat dibatalkan SEKARANG, dan berapa yang kembali
 * (Step 25). Dipakai pratinjau dan permintaan pembatalan, supaya angka yang
 * dilihat pengguna dan angka yang disetujui dihitung dengan jalan yang sama.
 */

export type NotCancellableReason =
  /** Belum terkonfirmasi: pembatalan sebelum bayar terjadi sendiri saat hold habis. */
  | 'not_confirmed'
  /** Pembatalan sedang berjalan. */
  | 'in_progress'
  | 'already_cancelled'
  /** Tanggal masuk sudah dimulai di properti. */
  | 'stay_started'
  /** Pemesanan sebelum Step 25 tanpa jadwal pengembalian yang tercatat. */
  | 'policy_unknown'
  /** Zona waktu properti tidak dikenal katalog. Tidak ditebak. */
  | 'time_zone_unknown'

export type CancellationAssessment =
  | {
      readonly kind: 'quoted'
      readonly booking: BookingIn<'CONFIRMED'>
      readonly quote: RefundQuote
    }
  | { readonly kind: 'not_cancellable'; readonly reason: NotCancellableReason }
  /** Katalog belum menjawab. Tidak ada yang berubah; pengguna boleh mencoba lagi. */
  | { readonly kind: 'retry_later' }

export async function assessCancellation(
  deps: BookingDeps,
  booking: Booking,
  at: Date,
): Promise<CancellationAssessment> {
  if (booking.status !== 'CONFIRMED') {
    return { kind: 'not_cancellable', reason: reasonFor(booking) }
  }

  const schedule = booking.refundSchedule
  if (schedule === undefined) return { kind: 'not_cancellable', reason: 'policy_unknown' }

  const zone = await deps.properties.timeZoneOf(booking.supplier, booking.propertyId)
  if (zone.kind === 'unreachable') return { kind: 'retry_later' }
  if (zone.kind === 'not_found') return { kind: 'not_cancellable', reason: 'time_zone_unknown' }

  const quote = quoteRefund({
    schedule,
    checkIn: booking.stay.checkIn,
    timeZone: zone.timeZone,
    paid: booking.price.total,
    at,
  })
  if (!quote.ok) {
    return {
      kind: 'not_cancellable',
      reason: quote.error.kind === 'stay_started' ? 'stay_started' : 'time_zone_unknown',
    }
  }

  return { kind: 'quoted', booking, quote: quote.value }
}

const ENDED_WITHOUT_STAY: readonly Booking['status'][] = ['CANCELLED', 'EXPIRED', 'REFUNDED']

function reasonFor(booking: Booking): NotCancellableReason {
  if (isCancellationUnderway(booking) && booking.status !== 'CANCELLED') return 'in_progress'
  if (ENDED_WITHOUT_STAY.includes(booking.status)) return 'already_cancelled'

  return 'not_confirmed'
}

/** Pemesanan yang sudah dibatalkan pengguna setelah terkonfirmasi (Step 25). */
export function isCancelledByUser(booking: Booking): boolean {
  return booking.status === 'CANCELLED' && booking.cancellationRequest !== undefined
}

/**
 * Pembatalan oleh pengguna yang sudah diterima: sedang berjalan, tuntas, atau
 * diserahkan ke manusia. Permintaan ulang untuk pemesanan seperti ini dijawab
 * dengan keadaannya, tidak dihitung ulang.
 */
export function isCancellationUnderway(booking: Booking): boolean {
  if (booking.status === 'CANCELLING') return true
  if (booking.status === 'NEEDS_REVIEW') return booking.review.from === 'CANCELLING'

  return isCancelledByUser(booking)
}
