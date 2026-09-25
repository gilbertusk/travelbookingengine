import type { Money } from '@tbe/money'

/**
 * Pembayaran sebagai state machine eksplisit.
 *
 * Bentuknya union diskriminan, bukan satu objek dengan bendera status —
 * CONVENTIONS.md bagian 3. Yang dibeli dengan itu bukan keindahan: keadaan
 * SUCCEEDED WAJIB membawa rujukan transaksi penyedia, dan keadaan PENDING tidak
 * boleh punya. Dengan union, membaca `payment.gatewayRef` tanpa mempersempit
 * status lebih dulu tidak dapat dikompilasi — sementara dengan bidang nullable,
 * ia dapat dikompilasi, lulus seluruh uji jalur bahagia, lalu mengirim
 * `undefined` sebagai rujukan refund ke penyedia pada pembayaran yang belum
 * dibayar.
 */

export const PAYMENT_STATUSES = [
  'PENDING',
  'SUCCEEDED',
  'FAILED',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
] as const

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number]

/**
 * Keadaan yang tidak punya transisi keluar.
 *
 * FAILED final karena tidak ada uang yang berpindah: percobaan bayar berikutnya
 * adalah maksud pembayaran BARU, bukan kebangkitan yang gagal. REFUNDED final
 * karena seluruh dana sudah kembali.
 *
 * SUCCEEDED dan PARTIALLY_REFUNDED sengaja TIDAK final — keduanya masih dapat
 * menerima refund. Daftar ini diperiksa uji terhadap [TRANSITIONS] dari dua
 * arah, supaya klaim finalitas di sini tidak dapat menyimpang dari tabelnya.
 */
export const FINAL_STATUSES: readonly PaymentStatus[] = ['FAILED', 'REFUNDED']

export function isFinal(status: PaymentStatus): boolean {
  return FINAL_STATUSES.includes(status)
}

export const REFUND_STATUSES = ['PENDING', 'SUCCEEDED', 'FAILED'] as const
export type RefundStatus = (typeof REFUND_STATUSES)[number]

export const REFUND_REASONS = ['supplier_failed', 'user_cancelled', 'manual'] as const
export type RefundReason = (typeof REFUND_REASONS)[number]

/**
 * Refund sebagai entitas tersendiri — satu pembayaran dapat punya beberapa.
 *
 * Ia tinggal di dalam agregat Payment, bukan berdiri sendiri, karena aturan
 * yang paling mahal bila dilanggar adalah aturan LINTAS refund: total seluruh
 * refund tidak boleh melebihi nilai pembayaran. Aturan itu tidak dapat
 * ditegakkan oleh satu refund yang hanya mengenal dirinya sendiri.
 */
export interface Refund {
  readonly id: string
  /** Pengenal permintaan. Refund idempoten terhadap nilai ini, bukan terhadap id. */
  readonly requestId: string
  readonly amount: Money
  readonly reason: RefundReason
  readonly status: RefundStatus
  readonly gatewayRef: string | undefined
}

interface PaymentBase {
  readonly id: string
  readonly bookingId: string
  /**
   * Nilai yang ditagih. Berasal dari harga yang DISETUJUI pengguna — lihat
   * application/create-payment-intent.ts — bukan dari harga saat pemesanan
   * dibuat, dan bukan dari nilai yang dikirim pemanggil.
   */
  readonly amount: Money
  readonly idempotencyKey: string
}

/** Keadaan yang sudah pasti ada uangnya, dan karena itu dapat direfund. */
interface SettledFields {
  /** `transaction_id` dari penyedia. Rujukan yang dipakai saat meminta refund. */
  readonly gatewayRef: string
  readonly refunds: readonly Refund[]
}

export type Payment =
  | (PaymentBase & { readonly status: 'PENDING' })
  | (PaymentBase & { readonly status: 'FAILED'; readonly failureReason: string })
  | (PaymentBase & { readonly status: 'SUCCEEDED' } & SettledFields)
  | (PaymentBase & { readonly status: 'PARTIALLY_REFUNDED' } & SettledFields)
  | (PaymentBase & { readonly status: 'REFUNDED' } & SettledFields)

/** Pembayaran yang sudah tertagih, dalam bentuk yang membawa daftar refund. */
export type SettledPayment = Extract<Payment, SettledFields>

/**
 * Keadaan yang dapat DIHASILKAN sebuah notifikasi penyedia.
 *
 * Hanya dua, dan tipe ini yang menyatakannya. Tanpanya, pemanggil menerima
 * `Payment` — lima keadaan — dan harus menangani tiga keadaan yang tidak pernah
 * mungkin muncul dari jalur ini. Cakupan uji yang memperlihatkan cabang yang
 * tidak pernah tersentuh adalah yang menemukannya: cabang itu memang tidak dapat
 * dibuktikan benar, jadi yang salah adalah tipenya, bukan ujinya.
 */
export type AppliedPayment = Extract<Payment, { readonly status: 'SUCCEEDED' | 'FAILED' }>

export function isSettled(payment: Payment): payment is SettledPayment {
  return payment.status !== 'PENDING' && payment.status !== 'FAILED'
}

export interface CreatePaymentInput {
  readonly id: string
  readonly bookingId: string
  readonly amount: Money
  readonly idempotencyKey: string
}

export function createPayment(input: CreatePaymentInput): Payment {
  return { ...input, status: 'PENDING' }
}

/**
 * Hasil pembayaran menurut penyedia, sudah dipetakan ke istilah kita.
 *
 * Pemetaan dari status mentah Midtrans dilakukan di [provider-status.ts]
 * sebagai tabel. Domain tidak pernah melihat kata "settlement" maupun "deny".
 */
export const PROVIDER_OUTCOMES = ['PENDING', 'SUCCEEDED', 'FAILED'] as const
export type ProviderOutcome = (typeof PROVIDER_OUTCOMES)[number]

export interface ProviderNotification {
  readonly outcome: ProviderOutcome
  readonly gatewayRef: string
  /** gross_amount dari penyedia, sudah diurai menjadi Money tanpa pecahan biner. */
  readonly amount: Money
  /** Pesan status penyedia bila gagal. */
  readonly reason: string | undefined
}

type TransitionDecision = 'apply' | 'unchanged' | 'out_of_order'

/**
 * Tabel transisi, dinyatakan sebagai data.
 *
 * Lima keadaan kali tiga hasil penyedia: lima belas sel, semuanya diputuskan di
 * sini dan semuanya diperiksa uji. Ditulis sebagai rangkaian `if`, tiga sel
 * akan terlupa — dan yang terlupa pada penanganan webhook selalu sel yang sama:
 * notifikasi yang tiba pada keadaan yang sudah final.
 *
 * Tiga keputusan yang membedakan tabel ini dari "yang terakhir menang":
 *
 * - `FAILED` + `SUCCEEDED` → `out_of_order`. Inilah Definisi Selesai
 *   "webhook tidak berurutan tidak merusak keadaan final". Midtrans tidak
 *   menjamin urutan notifikasi, jadi sukses setelah gagal adalah kejadian yang
 *   diperkirakan. Menerapkannya berarti menandai berhasil sesuatu yang
 *   kompensasinya mungkin sudah berjalan.
 * - `SUCCEEDED` + `FAILED` → `out_of_order`. Arah sebaliknya lebih berbahaya:
 *   ia menghapus catatan bahwa uang sudah diambil.
 * - `PENDING` pada keadaan apa pun selain PENDING → `unchanged`. Notifikasi
 *   pending yang tiba terlambat tidak membawa informasi baru, dan memutarnya
 *   kembali ke PENDING akan membuat pemesanan yang sudah selesai menunggu lagi.
 */
export const TRANSITIONS: Readonly<
  Record<PaymentStatus, Readonly<Record<ProviderOutcome, TransitionDecision>>>
> = {
  PENDING: { PENDING: 'unchanged', SUCCEEDED: 'apply', FAILED: 'apply' },
  SUCCEEDED: { PENDING: 'unchanged', SUCCEEDED: 'unchanged', FAILED: 'out_of_order' },
  FAILED: { PENDING: 'unchanged', SUCCEEDED: 'out_of_order', FAILED: 'unchanged' },
  PARTIALLY_REFUNDED: { PENDING: 'unchanged', SUCCEEDED: 'unchanged', FAILED: 'out_of_order' },
  REFUNDED: { PENDING: 'unchanged', SUCCEEDED: 'unchanged', FAILED: 'out_of_order' },
}

/**
 * Hasil penerapan notifikasi.
 *
 * Keempatnya jawaban yang sah, bukan kegagalan — CONVENTIONS.md bagian 5.
 * Seluruhnya membawa pembayarannya, sehingga pemanggil menyimpan dan melaporkan
 * dengan cara yang sama tanpa mempersempit dua kali.
 */
export type NotificationResult =
  | { readonly kind: 'applied'; readonly payment: AppliedPayment }
  | { readonly kind: 'unchanged'; readonly payment: Payment }
  | {
      readonly kind: 'out_of_order'
      readonly payment: Payment
      readonly attempted: ProviderOutcome
    }
  | { readonly kind: 'amount_mismatch'; readonly payment: Payment; readonly notified: Money }

export function applyProviderOutcome(
  payment: Payment,
  notification: ProviderNotification,
): NotificationResult {
  const decision = TRANSITIONS[payment.status][notification.outcome]

  if (decision === 'unchanged') return { kind: 'unchanged', payment }

  if (decision === 'out_of_order') {
    return { kind: 'out_of_order', payment, attempted: notification.outcome }
  }

  // Nilai hanya diperiksa ketika keadaan benar-benar akan berubah. Notifikasi
  // yang tidak mengubah apa pun tidak perlu dihalangi oleh nilai yang berbeda.
  if (!isSameMoney(payment.amount, notification.amount)) {
    return { kind: 'amount_mismatch', payment, notified: notification.amount }
  }

  return { kind: 'applied', payment: transition(payment, notification) }
}

function transition(payment: Payment, notification: ProviderNotification): AppliedPayment {
  // Bidang dasar disusun ulang secara eksplisit alih-alih disebar dari
  // pembayaran lama. Menyebar akan ikut membawa bidang khas keadaan
  // sebelumnya — `failureReason` dari FAILED, `refunds` dari SUCCEEDED — ke
  // keadaan yang seharusnya tidak memilikinya, dan union tidak menolaknya
  // karena bidang berlebih pada objek yang sudah bertipe lolos pemeriksaan.
  const base = {
    id: payment.id,
    bookingId: payment.bookingId,
    amount: payment.amount,
    idempotencyKey: payment.idempotencyKey,
  }

  if (notification.outcome === 'FAILED') {
    return { ...base, status: 'FAILED', failureReason: notification.reason ?? 'tidak disebutkan' }
  }

  return { ...base, status: 'SUCCEEDED', gatewayRef: notification.gatewayRef, refunds: [] }
}

/**
 * Perbandingan uang yang tidak melempar.
 *
 * `equals` dari @tbe/money melempar TypeError untuk mata uang berbeda, dan itu
 * benar untuk perhitungan. Di sini mata uang yang berbeda adalah DATA yang
 * salah dari luar, bukan cacat program: melemparnya membuat notifikasi cacat
 * terlihat seperti kerusakan sistem, lalu dicoba ulang penyedia tanpa henti.
 */
function isSameMoney(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.amountMinor === b.amountMinor
}
