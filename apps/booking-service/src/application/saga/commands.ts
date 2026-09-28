import { createHash } from 'node:crypto'
import { toJson, type Money } from '@tbe/money'
import type { Booking, BookingIn } from '../../domain/booking.js'
import type { OutboundCommand } from '../ports.js'

/**
 * Perintah yang dikirim saga, sebagai data untuk outbox.
 *
 * Setiap perintah membawa kunci idempotensi yang DITURUNKAN dari pemesanan —
 * bukan dibuat acak — karena saga dapat mengirim perintah yang sama lebih dari
 * sekali: outbox menjamin minimal sekali, dan pemulihan dapat mengulang
 * langkah yang hasilnya tidak diketahui. Kunci acak membuat setiap
 * pengulangan menjadi pekerjaan baru; kunci turunan membuatnya pengulangan
 * yang dikenali penerimanya.
 */

/** Alasan refund pada kontrak `payment.refund`. */
export type RefundReason = Extract<OutboundCommand, { type: 'payment.refund' }>['payload']['reason']

/**
 * Kunci idempotensi `book` di supplier: id pemesanan. Satu pemesanan, satu
 * kunci, pada setiap percobaan — dan itulah yang membuat supplier-service
 * mengadopsi pemesanan yang sudah terbentuk alih-alih membuat yang kedua
 * (US-05).
 */
export function supplierIdempotencyKey(bookingId: string): string {
  return bookingId
}

/**
 * Pengenal permintaan refund, turunan dari pemesanan DAN pembayarannya.
 *
 * Deterministik: perintah yang terkirim dua kali memakai pengenal yang sama,
 * dan payment-service menolak refund kedua lewat batasan UNIK-nya. Pembayaran
 * yang berbeda untuk pemesanan yang sama — pembayaran kedua yang tiba setelah
 * pemesanan batal — memperoleh pengenal berbeda, karena memang dua uang yang
 * harus dikembalikan.
 *
 * Bentuknya UUID versi 8 (RFC 9562, "custom"): 122 bit dari SHA-256, dengan
 * bit versi dan varian dipasang. Kontrak menuntut UUID.
 */
export function refundRequestIdFor(bookingId: string, paymentId: string): string {
  const hex = createHash('sha256').update(`refund:${bookingId}:${paymentId}`).digest('hex')
  const variant = ((Number.parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16)

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `8${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-')
}

/** `supplier.confirm` — dari pemesanan yang MASIH HELD, karena hanya ia yang membawa token hold. */
export function supplierConfirm(held: BookingIn<'HELD'>): OutboundCommand {
  return {
    type: 'supplier.confirm',
    payload: {
      bookingId: held.id,
      supplier: held.supplier,
      holdRef: held.holdRef,
      guestName: held.guests.leadGuest.fullName,
      idempotencyKey: supplierIdempotencyKey(held.id),
    },
  }
}

export function refundPayment(
  booking: Booking,
  payment: { readonly paymentId: string; readonly amount: Money },
  reason: RefundReason,
): OutboundCommand {
  return {
    type: 'payment.refund',
    payload: {
      refundRequestId: refundRequestIdFor(booking.id, payment.paymentId),
      paymentId: payment.paymentId,
      bookingId: booking.id,
      amount: toJson(payment.amount),
      reason,
    },
  }
}

export function supplierCancel(booking: Booking, supplierRef: string): OutboundCommand {
  return {
    type: 'supplier.cancel',
    payload: { bookingId: booking.id, supplier: booking.supplier, supplierRef },
  }
}

export function voucherGenerate(bookingId: string): OutboundCommand {
  return { type: 'voucher.generate', payload: { bookingId } }
}
