import { createHmac } from 'node:crypto'

/**
 * Aturan penghantaran: kapan mencoba lagi, alamat mana yang layak dicoba, dan
 * berapa banyak surel boleh menuju satu penerima.
 */

/**
 * Jenjang tunda sesudah kegagalan sementara (NFR-05).
 *
 * Lebih panjang dari jenjang perintah RabbitMQ (5 detik, 30 detik, 2 menit):
 * server SMTP yang mati biasanya mati beberapa menit, bukan beberapa detik,
 * dan surel kegagalan pemesanan yang tiba 30 menit terlambat jauh lebih baik
 * daripada surel yang tidak pernah tiba. Total kira-kira 43 menit sebelum
 * dead letter.
 */
export const RETRY_DELAYS_MS: readonly number[] = [5_000, 30_000, 120_000, 600_000, 1_800_000]

export type FailureOutcome =
  | { readonly kind: 'retry'; readonly attempts: number; readonly nextAttemptAt: Date }
  | { readonly kind: 'dead'; readonly attempts: number }

/** `attemptsBefore`: percobaan yang SUDAH gagal sebelum yang baru saja gagal. */
export function afterTransientFailure(attemptsBefore: number, now: Date): FailureOutcome {
  const attempts = attemptsBefore + 1
  const delay = RETRY_DELAYS_MS[attemptsBefore]

  return delay === undefined
    ? { kind: 'dead', attempts }
    : { kind: 'retry', attempts, nextAttemptAt: new Date(now.getTime() + delay) }
}

/**
 * Alasan percobaan ulang surel konfirmasi yang vouchernya belum terbit. Satu-
 * satunya alasan yang boleh dibangunkan duplikat (`voucher.issued`).
 */
export const VOUCHER_NOT_READY = 'voucher_not_ready'

/** Batas panjang alamat pada jalur SMTP (RFC 5321). */
const MAX_ADDRESS_LENGTH = 254

/**
 * Pemeriksaan longgar seperti di booking-service, ditambah satu larangan:
 * tanda pemisah daftar alamat (`,` `;`) dan tanda kutip/kurung sudut. Pustaka
 * SMTP membaca "a@x.com, b@y.com" sebagai DUA penerima, dan voucher tidak
 * boleh ikut terkirim ke alamat kedua yang diselipkan di kolom surel tamu.
 * Alamat yang ditolak di sini berarti datanya rusak; mencobanya ulang tidak
 * akan memperbaikinya.
 */
const EMAIL = /^[^\s@,;<>"()]+@[^\s@,;<>"()]+\.[^\s@,;<>"()]+$/

export function isDeliverableAddress(email: string): boolean {
  return email.length <= MAX_ADDRESS_LENGTH && EMAIL.test(email)
}

/**
 * Kunci penerima untuk pembatasan laju: HMAC-SHA-256 alamat yang dinormalkan.
 *
 * Batas laju butuh tahu "surel ke orang yang sama", tetapi tidak butuh tahu
 * siapa orangnya. HMAC, bukan hash polos: hash polos alamat surel dapat
 * dicocokkan siapa pun yang membaca basis data dengan daftar alamat yang ia
 * punya. Tanpa rahasianya, kunci ini tidak dapat dicocokkan ke alamat mana pun.
 */
export function recipientKey(email: string, secret: string): string {
  return createHmac('sha256', secret).update(email.trim().toLowerCase()).digest('hex')
}

/** Jendela pembatasan laju. */
export const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1_000

/** Jeda sebelum surel yang tertahan batas laju dicoba lagi. */
export const RATE_LIMIT_DEFER_MS = 15 * 60 * 1_000

export type RateDecision =
  { readonly kind: 'allow' } | { readonly kind: 'defer'; readonly until: Date }

/**
 * Surel yang melewati batas DITUNDA, tidak dibuang.
 *
 * Batas ini menahan banjir — peristiwa yang berulang karena cacat, atau
 * perintah yang dikirim dalam putaran — bukan menyaring surel. Pemesanan wajar
 * menghasilkan paling banyak tiga atau empat surel; surel kegagalan yang
 * dibuang karena batas laju adalah kegagalan FR-23.
 */
export function rateDecision(sentInWindow: number, limit: number, now: Date): RateDecision {
  return sentInWindow < limit
    ? { kind: 'allow' }
    : { kind: 'defer', until: new Date(now.getTime() + RATE_LIMIT_DEFER_MS) }
}
