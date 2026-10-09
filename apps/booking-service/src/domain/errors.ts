import { AppError } from '@tbe/shared-kernel'
import type { BookingStatus } from './booking.js'
import type { CommandType } from './commands.js'

/**
 * Galat domain pemesanan.
 *
 * Dua kelas, dan pembedaannya bukan hiasan. [InvalidTransitionError] berarti
 * perintahnya tidak punya arti pada keadaan ini sama sekali — membayar
 * pemesanan yang sudah kedaluwarsa. [BookingRuleError] berarti perintahnya sah
 * pada keadaan ini, tetapi datanya melanggar aturan — membayar pemesanan yang
 * tertahan dengan nilai yang berbeda dari harga yang disetujui.
 *
 * Keduanya DIKEMBALIKAN sebagai nilai lewat Result, tidak dilempar —
 * CONVENTIONS.md bagian 5. Pembayaran yang tiba setelah hold kedaluwarsa bukan
 * cacat program; itu kejadian yang diperkirakan, dan saga Step 19 harus
 * memutuskan apa yang dilakukan terhadap uangnya. Galat yang dilempar mudah
 * tertangkap `catch` umum dan hilang; galat yang dikembalikan harus ditangani
 * sebelum kodenya dapat dikompilasi.
 *
 * Keduanya 409: permintaannya dapat dipahami, tetapi bertentangan dengan
 * keadaan pemesanan sekarang.
 */

export class InvalidTransitionError extends AppError {
  readonly kind = 'invalid_transition'
  readonly from: BookingStatus
  readonly command: CommandType

  constructor(bookingId: string, from: BookingStatus, command: CommandType) {
    super({
      code: 'INVALID_BOOKING_TRANSITION',
      httpStatus: 409,
      message: `Perintah ${command} tidak berlaku untuk pemesanan berstatus ${from}`,
      details: { bookingId, from, command },
    })
    this.from = from
    this.command = command
  }
}

export const BOOKING_RULES = [
  /** Harga berubah dan belum disetujui. Price check ulang tidak mengubahnya. */
  'price_awaiting_approval',
  /** Harga baru sudah disetujui, tetapi belum diverifikasi ulang ke supplier. */
  'price_not_reverified',
  /** Tidak ada perubahan harga yang dapat disetujui. */
  'no_price_change',
  /** Batas waktu hold tidak berada di masa depan saat hold dibuat. */
  'hold_window_invalid',
  /** Hold diminta kedaluwarsa sebelum batas waktunya. */
  'hold_not_expired',
  /** Nilai pembayaran atau refund berbeda dari harga yang disetujui. */
  'amount_mismatch',
  /**
   * Bidang wajib kosong: rujukan eksternal (holdRef, paymentId, supplierRef,
   * refundId) atau alasan kegagalan dan peninjauan. Pemesanan NEEDS_REVIEW
   * tanpa alasan sama tidak bergunanya bagi manusia yang memeriksanya dengan
   * CONFIRMED tanpa booking reference bagi pengguna.
   */
  'blank_field',
  /** Nilai pengembalian melebihi pembayaran, negatif, atau dalam mata uang lain. */
  'refund_exceeds_payment',
  /** Langkah pembatalan tidak sesuai perintahnya — mis. refund sebelum supplier menjawab. */
  'cancellation_stage_mismatch',
  /** Tidak ada dana yang perlu dikembalikan, atau sebaliknya ada yang tidak boleh dilewati. */
  'refund_due_mismatch',
  /** Batas waktu menunggu jawaban tidak berada di masa depan. */
  'deadline_in_past',
] as const

export type BookingRule = (typeof BOOKING_RULES)[number]

export class BookingRuleError extends AppError {
  readonly kind = 'rule_violation'
  readonly rule: BookingRule

  constructor(bookingId: string, rule: BookingRule, message: string) {
    super({
      code: 'BOOKING_RULE_VIOLATION',
      httpStatus: 409,
      message,
      details: { bookingId, rule },
    })
    this.rule = rule
  }
}

export type BookingError = InvalidTransitionError | BookingRuleError
