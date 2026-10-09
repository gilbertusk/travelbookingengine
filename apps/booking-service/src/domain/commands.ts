import type { Money } from '@tbe/money'
import type { BookingStatus, CancellationReason } from './booking.js'
import type { CancellationPolicy } from './offer-terms.js'
import type { PriceBreakdown } from './price.js'

/**
 * Perintah yang memindahkan pemesanan dari satu keadaan ke keadaan lain.
 *
 * Setiap perintah membawa `at` — waktu kejadiannya — dari pemanggil. Domain
 * tidak pernah membaca jam sendiri: aturan seperti "hold belum kedaluwarsa"
 * harus dapat diuji pada detik mana pun tanpa menunggu, dan harus memberi
 * jawaban yang sama saat diputar ulang dari booking_events.
 */

interface CommandBase {
  readonly at: Date
}

export type BookingCommand =
  /** Hasil price check dari supplier (Step 17), beserta kebijakan pembatalannya (Step 25). */
  | (CommandBase & {
      readonly type: 'verifyPrice'
      readonly verified: PriceBreakdown
      readonly policy: CancellationPolicy
    })
  /** Pengguna menyetujui harga yang berubah (FR-14). */
  | (CommandBase & { readonly type: 'acceptPrice' })
  /** Inventaris tertahan di Redis dan di supplier (Step 17). */
  | (CommandBase & {
      readonly type: 'hold'
      /** Token hold dari supplier, dibutuhkan untuk melepaskannya. */
      readonly holdRef: string
      /** Yang lebih awal antara kedaluwarsa lokal dan kedaluwarsa supplier. */
      readonly heldUntil: Date
    })
  | (CommandBase & { readonly type: 'expireHold' })
  /** payment.succeeded dari payment-service. */
  | (CommandBase & {
      readonly type: 'recordPayment'
      readonly paymentId: string
      readonly amount: Money
    })
  /** Supplier menerbitkan booking reference. */
  | (CommandBase & { readonly type: 'confirm'; readonly supplierRef: string })
  /** Konfirmasi supplier gagal permanen setelah uang diterima. */
  | (CommandBase & { readonly type: 'fail'; readonly reason: string })
  /** payment.refunded dari payment-service. */
  | (CommandBase & {
      readonly type: 'recordRefund'
      readonly refundId: string
      readonly amount: Money
    })
  | (CommandBase & { readonly type: 'cancel'; readonly reason: CancellationReason })
  /** Status tidak dapat dipastikan, atau kompensasi gagal (US-05). */
  | (CommandBase & { readonly type: 'requireReview'; readonly reason: string })
  /** Pengguna membatalkan pemesanan yang sudah terkonfirmasi (Step 25, FR-27). */
  | (CommandBase & {
      readonly type: 'requestCancellation'
      readonly quote: CancellationQuote
      /** Batas menunggu jawaban `supplier.cancel`. */
      readonly replyBy: Date
    })
  /** supplier.booking_cancelled: kamar sudah lepas, refund mulai dikirim. */
  | (CommandBase & { readonly type: 'confirmSupplierCancellation'; readonly refundBy: Date })
  /** Pembatalan tuntas: refund selesai, atau memang tidak ada yang dikembalikan. */
  | (CommandBase & {
      readonly type: 'completeCancellation'
      readonly settlement:
        | { readonly kind: 'nothing_due' }
        | { readonly kind: 'refunded'; readonly refundId: string; readonly amount: Money }
    })
  /** supplier.booking_cancel_failed: kamar masih terpesan, pemesanan kembali aktif. */
  | (CommandBase & { readonly type: 'restoreConfirmation'; readonly reason: string })

/**
 * Hasil perhitungan pengembalian yang disetujui pengguna (Step 25).
 *
 * Dihitung di lapisan aplikasi — zona waktu properti datang dari katalog,
 * bukan dari domain — dan diperiksa domain terhadap pembayaran yang tercatat.
 * Seluruhnya masuk jejak audit, termasuk zona dan titik acuan yang dipakai:
 * "kenapa saya hanya dapat 50%" harus dapat dijawab dari booking_events.
 */
export interface CancellationQuote {
  readonly refund: Money
  readonly percent: number
  /** Sampai kapan persentase ini berlaku. */
  readonly until: Date
  readonly timeZone: string
  readonly checkInStartsAt: Date
}

export type CommandType = BookingCommand['type']

export type CommandOf<C extends CommandType> = Extract<BookingCommand, { readonly type: C }>

export const COMMAND_TYPES = [
  'verifyPrice',
  'acceptPrice',
  'hold',
  'expireHold',
  'recordPayment',
  'confirm',
  'fail',
  'recordRefund',
  'cancel',
  'requireReview',
  'requestCancellation',
  'confirmSupplierCancellation',
  'completeCancellation',
  'restoreConfirmation',
] as const satisfies readonly CommandType[]

/**
 * Keadaan tujuan setiap perintah. Bagian dari tabel transisi, dinyatakan
 * sebagai data.
 *
 * Tujuan tidak bergantung pada keadaan asal: `cancel` selalu berakhir di
 * CANCELLED, dari mana pun asalnya. Karena itu tabel transisi di
 * transitions.ts cukup menyatakan perintah mana yang sah pada keadaan mana,
 * dan graf keadaannya diturunkan dari kedua tabel ini — itulah yang ditelusuri
 * uji "selalu ada jalur menuju keadaan final".
 *
 * `as const` bukan hiasan: tipe handler diturunkan dari sini, sehingga handler
 * `hold` yang mengembalikan keadaan selain HELD ditolak compiler.
 */
export const COMMAND_TARGETS = {
  verifyPrice: 'PRICE_CHECKED',
  acceptPrice: 'PRICE_CHECKED',
  hold: 'HELD',
  expireHold: 'EXPIRED',
  recordPayment: 'PAID',
  confirm: 'CONFIRMED',
  fail: 'FAILED',
  recordRefund: 'REFUNDED',
  cancel: 'CANCELLED',
  requireReview: 'NEEDS_REVIEW',
  requestCancellation: 'CANCELLING',
  confirmSupplierCancellation: 'CANCELLING',
  completeCancellation: 'CANCELLED',
  restoreConfirmation: 'CONFIRMED',
} as const satisfies Readonly<Record<CommandType, BookingStatus>>

export type TargetOf<C extends CommandType> = (typeof COMMAND_TARGETS)[C]
