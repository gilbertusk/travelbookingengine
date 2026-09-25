import { compare, isNegative, isZero, subtract, sum, type Money } from '@tbe/money'
import {
  isSettled,
  type Payment,
  type PaymentStatus,
  type Refund,
  type RefundReason,
  type SettledPayment,
} from './payment.js'

/**
 * Aturan refund.
 *
 * Satu aturan yang membedakan berkas ini dari pembungkus di atas basis data:
 * **total seluruh refund tidak boleh melebihi nilai pembayaran, dan itu
 * diputuskan di sini.** Batasan basis data tidak dapat menggantikannya, karena
 * batasan basis data baru berbicara setelah baris ditulis — sementara panggilan
 * refund ke penyedia terjadi sebelum itu. Menolak setelah uangnya keluar bukan
 * penolakan, hanya laporan.
 */

/**
 * Keadaan pembayaran yang menerima permintaan refund, dinyatakan sebagai data.
 *
 * Bersama tabel notifikasi di payment.ts, tabel ini menyusun seluruh transisi
 * keluar yang dimiliki sebuah pembayaran. Uji di refund.test.ts membandingkan
 * gabungan keduanya dengan FINAL_STATUSES dari dua arah — itulah bukti bahwa
 * tepat keadaan final yang tidak punya jalan keluar.
 */
export const REFUNDABLE_STATUSES: Readonly<Record<PaymentStatus, boolean>> = {
  /** Belum ada uang yang masuk. Yang perlu dilakukan adalah membatalkan, bukan mengembalikan. */
  PENDING: false,
  /** Tidak pernah ada uang yang masuk. */
  FAILED: false,
  SUCCEEDED: true,
  PARTIALLY_REFUNDED: true,
  /** Sudah kembali seluruhnya. */
  REFUNDED: false,
}

export interface RefundRequest {
  readonly id: string
  readonly requestId: string
  readonly amount: Money
  readonly reason: RefundReason
}

export type RefundRejection =
  'not_refundable' | 'exceeds_total' | 'currency_mismatch' | 'not_positive'

export type RefundRequestResult =
  | { readonly kind: 'accepted'; readonly payment: SettledPayment; readonly refund: Refund }
  | {
      readonly kind: 'already_requested'
      readonly payment: SettledPayment
      readonly refund: Refund
    }
  | { readonly kind: 'rejected'; readonly reason: RefundRejection }

/**
 * Refund yang sudah mengikat kuota.
 *
 * Refund yang MASIH MENUNGGU ikut dihitung, bukan hanya yang sudah berhasil.
 * Alasannya sederhana dan mahal: dua permintaan refund yang masing-masing di
 * bawah batas, tetapi jumlahnya melebihi, akan sama-sama lolos bila hanya yang
 * sudah berhasil dihitung — dan keduanya sudah dikirim ke penyedia sebelum
 * kelebihannya terlihat.
 *
 * Refund yang GAGAL tidak dihitung: tidak ada uang yang keluar, jadi kuotanya
 * kembali.
 */
export function committedRefundTotal(payment: SettledPayment): Money {
  return totalOf(payment, (refund) => refund.status !== 'FAILED')
}

/** Nilai yang masih boleh dikembalikan. */
export function refundableRemaining(payment: SettledPayment): Money {
  return subtract(payment.amount, committedRefundTotal(payment))
}

export function requestRefund(payment: Payment, request: RefundRequest): RefundRequestResult {
  // Pembayaran yang belum pernah berhasil tidak punya refund sama sekali, jadi
  // tidak ada pengenal permintaan yang dapat dicocokkan lebih dulu.
  if (!isSettled(payment)) return { kind: 'rejected', reason: 'not_refundable' }

  const existing = payment.refunds.find((refund) => refund.requestId === request.requestId)

  /**
   * Idempotensi terhadap pengenal permintaan, DIPERIKSA LEBIH DULU daripada
   * keadaan pembayaran.
   *
   * Urutannya penting, dan urutan sebaliknya sempat ditulis di sini sebelum uji
   * menemukannya: refund yang berhasil mengembalikan SELURUH nilai membuat
   * pembayaran menjadi REFUNDED, yang bukan keadaan yang menerima refund.
   * Dengan pemeriksaan keadaan lebih dulu, perintah yang dikirim ulang RabbitMQ
   * untuk refund yang sudah tuntas dijawab "tidak dapat direfund" — terlihat
   * seperti kegagalan, lalu dicoba ulang sampai masuk dead letter, untuk
   * pekerjaan yang sebenarnya sudah selesai.
   *
   * "Sudah pernah diminta" adalah fakta tentang pengenal ini, bukan tentang
   * keadaan pembayaran sekarang.
   */
  if (existing !== undefined) {
    return { kind: 'already_requested', payment, refund: existing }
  }

  if (!REFUNDABLE_STATUSES[payment.status]) {
    return { kind: 'rejected', reason: 'not_refundable' }
  }

  // Nilai yang berbeda pada pengenal yang sama adalah perintah yang salah, bukan
  // permintaan baru — dan ia sudah tertangkap di atas: yang berlaku tetap yang
  // pertama.
  if (payment.amount.currency !== request.amount.currency) {
    return { kind: 'rejected', reason: 'currency_mismatch' }
  }

  if (isZero(request.amount) || isNegative(request.amount)) {
    return { kind: 'rejected', reason: 'not_positive' }
  }

  if (compare(request.amount, refundableRemaining(payment)) > 0) {
    return { kind: 'rejected', reason: 'exceeds_total' }
  }

  const refund: Refund = {
    id: request.id,
    requestId: request.requestId,
    amount: request.amount,
    reason: request.reason,
    status: 'PENDING',
    gatewayRef: undefined,
  }

  return {
    kind: 'accepted',
    payment: withRefunds(payment, [...payment.refunds, refund]),
    refund,
  }
}

export type RefundOutcome =
  { readonly kind: 'succeeded'; readonly gatewayRef: string } | { readonly kind: 'failed' }

export type RefundSettlementResult =
  | { readonly kind: 'settled'; readonly payment: SettledPayment; readonly refund: Refund }
  | { readonly kind: 'unchanged'; readonly payment: SettledPayment }
  | { readonly kind: 'unknown_refund'; readonly payment: SettledPayment }

/**
 * Mencatat hasil panggilan refund ke penyedia.
 *
 * Dikunci `requestId`, bukan `id`: pengenal itulah yang dibawa perintah
 * payment.refund, dan perintah yang dikirim ulang RabbitMQ membawa nilai yang
 * sama. Refund yang sudah selesai TIDAK diselesaikan ulang — perintah yang
 * tiba lagi setelah keberhasilan tidak boleh mengubahnya menjadi gagal.
 */
export function settleRefund(
  payment: SettledPayment,
  requestId: string,
  outcome: RefundOutcome,
): RefundSettlementResult {
  const target = payment.refunds.find((refund) => refund.requestId === requestId)

  if (target === undefined) return { kind: 'unknown_refund', payment }
  if (target.status !== 'PENDING') return { kind: 'unchanged', payment }

  const settledRefund: Refund = {
    ...target,
    status: outcome.kind === 'succeeded' ? 'SUCCEEDED' : 'FAILED',
    gatewayRef: outcome.kind === 'succeeded' ? outcome.gatewayRef : target.gatewayRef,
  }

  const refunds = payment.refunds.map((refund) =>
    refund.requestId === requestId ? settledRefund : refund,
  )

  return { kind: 'settled', payment: withRefunds(payment, refunds), refund: settledRefund }
}

/**
 * Status pembayaran diturunkan dari refund-nya, tidak disetel terpisah.
 *
 * Status dan daftar refund yang disimpan terpisah adalah dua sumber kebenaran
 * untuk satu fakta, dan keduanya akan menyimpang — biasanya pada refund kedua
 * yang menutup sisa nilainya.
 */
function withRefunds(payment: SettledPayment, refunds: readonly Refund[]): SettledPayment {
  const base = {
    id: payment.id,
    bookingId: payment.bookingId,
    amount: payment.amount,
    idempotencyKey: payment.idempotencyKey,
    gatewayRef: payment.gatewayRef,
    refunds,
  }

  const succeeded = totalOf({ ...payment, refunds }, (refund) => refund.status === 'SUCCEEDED')

  if (compare(succeeded, payment.amount) === 0) return { ...base, status: 'REFUNDED' }
  if (!isZero(succeeded)) return { ...base, status: 'PARTIALLY_REFUNDED' }

  return { ...base, status: 'SUCCEEDED' }
}

function totalOf(payment: SettledPayment, include: (refund: Refund) => boolean): Money {
  const currency = payment.amount.currency

  return sum(
    payment.refunds.filter(include).map((refund) => refund.amount),
    currency,
  )
}
