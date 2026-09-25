import type { ProviderOutcome } from './payment.js'

/**
 * Pemetaan status Midtrans ke istilah kita, dinyatakan sebagai tabel.
 *
 * Bukan rangkaian percabangan, dan itu diminta Step 18 secara eksplisit.
 * Alasannya dapat dilihat dari bentuknya: tabel membuat status yang TIDAK
 * dipetakan menjadi terlihat, sementara rangkaian `if` menyembunyikannya di
 * cabang terakhir. Status Midtrans yang tidak dipetakan dan jatuh ke `else`
 * adalah cara paling mudah menandai pembayaran gagal padahal uangnya sudah
 * masuk.
 */

export type StatusMapping =
  | { readonly kind: 'outcome'; readonly outcome: ProviderOutcome }
  /**
   * Status yang sah tetapi bukan urusan webhook ini. Keadaan refund dimiliki
   * alur refund kita sendiri — lihat application/refund-payment.ts — dan
   * notifikasi `refund` dari penyedia hanya menceritakan kembali apa yang kita
   * sendiri minta. Menerapkannya berarti dua sumber kebenaran untuk satu fakta.
   */
  | { readonly kind: 'ignored'; readonly why: 'refund_dimiliki_alur_refund' }
  | { readonly kind: 'unsupported' }

const SUCCEEDED: StatusMapping = { kind: 'outcome', outcome: 'SUCCEEDED' }
const PENDING: StatusMapping = { kind: 'outcome', outcome: 'PENDING' }
const FAILED: StatusMapping = { kind: 'outcome', outcome: 'FAILED' }
const IGNORED: StatusMapping = { kind: 'ignored', why: 'refund_dimiliki_alur_refund' }

/**
 * Seluruh nilai `transaction_status` yang dikirim Midtrans.
 *
 * Empat baris pertama adalah yang disebut Step 18. Empat sisanya ada karena
 * sandbox sungguhan mengirimnya juga, dan status yang tidak dipetakan berakhir
 * sebagai `unsupported` — yang berarti kita menolak notifikasi, dan penyedia
 * akan terus mengirimnya ulang. `authorize`, `refund`, dan `partial_refund`
 * karena itu diputuskan di sini, bukan dibiarkan jatuh.
 */
export const MIDTRANS_STATUS_MAP: Readonly<Record<string, StatusMapping>> = {
  capture: SUCCEEDED,
  settlement: SUCCEEDED,
  pending: PENDING,
  deny: FAILED,
  cancel: FAILED,
  expire: FAILED,
  failure: FAILED,

  /**
   * Kartu sudah disetujui penerbit tetapi dananya BELUM ditarik. Memetakannya
   * ke SUCCEEDED berarti menyatakan pembayaran diterima atas uang yang masih
   * berada di rekening pengguna, lalu mengonfirmasi kamar atas dasar itu.
   */
  authorize: PENDING,

  refund: IGNORED,
  partial_refund: IGNORED,
}

/**
 * Hasil pemeriksaan penipuan Midtrans, hanya bermakna pada pembayaran kartu.
 *
 * `challenge` berarti Midtrans meminta keputusan manual: dananya tertahan, dan
 * belum tentu pernah masuk. Ia MENIMPA `capture` yang tanpanya berarti sukses —
 * satu-satunya penyimpangan sengaja dari tabel yang diminta Step 18, dan
 * dicatat sebagai temuan pada step doc. Tanpa penimpaan ini, `capture` +
 * `challenge` akan mengonfirmasi kamar ke supplier atas pembayaran yang masih
 * mungkin dibatalkan, dan kerugiannya nyata.
 */
export const FRAUD_OVERRIDES: Readonly<Record<string, StatusMapping | undefined>> = {
  accept: undefined,
  challenge: PENDING,
  deny: FAILED,
}

/**
 * Pemetaan tidak peka huruf besar kecil secara sengaja TIDAK dilakukan.
 *
 * Midtrans mengirim huruf kecil. Menerima bentuk lain berarti menerima sesuatu
 * yang penyedia tidak pernah kirim, dan bila suatu hari bentuknya berubah, yang
 * benar adalah mengetahuinya lewat penolakan yang tercatat — bukan menerimanya
 * diam-diam karena kita sudah menormalkan lebih dulu.
 */
export function mapMidtransStatus(
  transactionStatus: string,
  fraudStatus: string | undefined,
): StatusMapping {
  const mapped = MIDTRANS_STATUS_MAP[transactionStatus] ?? { kind: 'unsupported' }

  if (mapped.kind !== 'outcome' || mapped.outcome !== 'SUCCEEDED') return mapped
  if (fraudStatus === undefined) return mapped

  // Hasil pemeriksaan penipuan yang TIDAK dikenal menahan pembayaran, bukan
  // meloloskannya. Nilai baru yang ditambahkan penyedia suatu hari lebih
  // mungkin berarti "ada yang perlu diperiksa" daripada "aman" — dan menunggu
  // dapat diperbaiki, sementara kamar yang sudah dikonfirmasi tidak.
  if (!Object.hasOwn(FRAUD_OVERRIDES, fraudStatus)) return PENDING

  return FRAUD_OVERRIDES[fraudStatus] ?? mapped
}
