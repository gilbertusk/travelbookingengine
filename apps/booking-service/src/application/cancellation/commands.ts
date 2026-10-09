import { createHash } from 'node:crypto'
import { toJson } from '@tbe/money'
import type { BookingIn } from '../../domain/booking.js'
import type { OutboundCommand } from '../ports.js'

/**
 * Perintah saga pembatalan (Step 25), sebagai data untuk outbox.
 */

/**
 * Pengenal permintaan refund pembatalan: turunan pemesanan DAN pembayarannya,
 * dalam ruang nama sendiri — berbeda dari refund kompensasi Step 19.
 *
 * Inilah batasan unik yang menjamin satu pembatalan tidak pernah
 * mengembalikan dana dua kali. Perintah yang terkirim ulang outbox, jawaban
 * supplier yang tiba dua kali, permintaan pembatalan yang diulang setelah
 * supplier gagal: semuanya membawa pengenal yang SAMA, dan payment-service
 * menolak refund kedua lewat batasan UNIK `request_id`-nya.
 *
 * UUID versi 8 dari SHA-256, seperti `refundRequestIdFor`.
 */
export function cancellationRefundRequestId(bookingId: string, paymentId: string): string {
  const hex = createHash('sha256')
    .update(`cancellation-refund:${bookingId}:${paymentId}`)
    .digest('hex')
  const variant = ((Number.parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16)

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `8${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-')
}

/** `payment.refund` sebesar nilai yang DISETUJUI saat pembatalan diminta. */
export function cancellationRefund(booking: BookingIn<'CANCELLING'>): OutboundCommand {
  return {
    type: 'payment.refund',
    payload: {
      refundRequestId: cancellationRefundRequestId(booking.id, booking.paymentId),
      paymentId: booking.paymentId,
      bookingId: booking.id,
      amount: toJson(booking.cancellationRequest.refund),
      reason: 'user_cancelled',
    },
  }
}
