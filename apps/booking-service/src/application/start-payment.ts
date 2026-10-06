import type { Booking } from '../domain/booking.js'
import { loadOwned } from './persist.js'
import type { BookingDeps, Payments } from './ports.js'

/**
 * Membuka pembayaran untuk pemesanan HELD (FR-19, Step 21).
 *
 * Pintu pengguna ke pembayaran ada di booking-service, bukan di
 * payment-service, karena hanya booking-service yang tahu dua hal yang harus
 * diperiksa lebih dulu: pemesanan ini MILIK pengguna yang meminta, dan
 * keadaannya masih HELD dengan hold yang belum lewat. payment-service tidak
 * mengenal pemilik pemesanan — rutenya `/internal/payments` sengaja tidak
 * diterbitkan api-gateway.
 *
 * Nilai yang ditagih diambil dari pemesanan, bukan dari klien. payment-service
 * membandingkannya sekali lagi dengan harga yang ia pelajari dari peristiwa
 * pemesanan (Step 18), jadi dua sisi harus sepakat sebelum uang berpindah.
 */

export interface StartPaymentRequest {
  readonly userId: string
  readonly bookingId: string
}

export type StartPaymentResult =
  | {
      readonly kind: 'started'
      readonly booking: Booking
      readonly paymentId: string
      readonly redirectUrl: string
      readonly snapToken: string
    }
  /** Pembayaran sudah diterima, atau pemesanan sudah melewatinya. Arahkan ke statusnya. */
  | { readonly kind: 'already_paid'; readonly booking: Booking }
  /** Belum di-hold, atau sudah berakhir tanpa pembayaran. */
  | { readonly kind: 'not_payable'; readonly booking: Booking }
  | { readonly kind: 'hold_expired'; readonly booking: Booking }
  | { readonly kind: 'retry_later' }
  | { readonly kind: 'rejected' }
  | { readonly kind: 'not_found' }

/** Keadaan yang hanya dapat dicapai lewat pembayaran yang sudah diterima. */
const PAST_PAYMENT = new Set(['PAID', 'CONFIRMED', 'FAILED', 'REFUNDED', 'NEEDS_REVIEW'])

/**
 * Satu kunci per pemesanan. Permintaan yang diulang — klik ganda, popup yang
 * ditutup lalu dibuka lagi — membuka transaksi yang SAMA di penyedia.
 */
export function paymentKeyOf(bookingId: string): string {
  return `booking:${bookingId}`
}

export async function startPayment(
  deps: BookingDeps,
  payments: Payments,
  request: StartPaymentRequest,
): Promise<StartPaymentResult> {
  const booking = await loadOwned(deps, request.userId, request.bookingId)
  if (booking === undefined) return { kind: 'not_found' }

  if (PAST_PAYMENT.has(booking.status)) return { kind: 'already_paid', booking }
  if (booking.status !== 'HELD') return { kind: 'not_payable', booking }
  // Penyapu mungkin belum memindahkannya ke EXPIRED. Yang menentukan adalah
  // batas waktunya, bukan keadaan yang belum sempat diperbarui.
  if (booking.heldUntil.getTime() <= deps.clock.now().getTime()) {
    return { kind: 'hold_expired', booking }
  }

  const answer = await payments.start({
    bookingId: booking.id,
    idempotencyKey: paymentKeyOf(booking.id),
    amount: booking.price.total,
  })

  switch (answer.kind) {
    case 'started':
      return {
        kind: 'started',
        booking,
        paymentId: answer.paymentId,
        redirectUrl: answer.redirectUrl,
        snapToken: answer.snapToken,
      }
    case 'settled':
      // Pembayaran sudah selesai di payment-service, tetapi peristiwanya belum
      // sampai ke sini. Statusnya yang akan menyusul.
      return { kind: 'already_paid', booking }
    case 'not_ready':
    case 'unreachable':
      return { kind: 'retry_later' }
    case 'rejected':
      return { kind: 'rejected' }
  }
}
