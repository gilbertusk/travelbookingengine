import type { Money } from '@tbe/money'
import type { BookingStatus, CancellationReason } from './booking.js'
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
  /** Hasil price check dari supplier (Step 17). */
  | (CommandBase & { readonly type: 'verifyPrice'; readonly verified: PriceBreakdown })
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
} as const satisfies Readonly<Record<CommandType, BookingStatus>>

export type TargetOf<C extends CommandType> = (typeof COMMAND_TARGETS)[C]
