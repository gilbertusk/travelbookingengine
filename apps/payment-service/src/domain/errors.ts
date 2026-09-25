import { AppError } from '@tbe/shared-kernel'

/**
 * Galat domain pembayaran.
 *
 * Keduanya ada demi satu keputusan: **apakah perintah refund layak dicoba
 * ulang.** Kebijakan percobaan ulang @tbe/messaging memutuskannya dari
 * `httpStatus` — 5xx dan 429 dicoba ulang, sisanya langsung ke dead letter —
 * jadi status di sini bukan hiasan HTTP. Ia yang menentukan apakah uang
 * pengguna akan dikejar lagi atau ditinggalkan untuk manusia.
 *
 * Perbedaannya tidak dapat disimpulkan dari pesan galat, dan karena itu tidak
 * dititipkan pada pesan.
 */

/**
 * Penyedia tidak dapat dihubungi. Layak dicoba ulang.
 *
 * 502 supaya `isRetryable` di @tbe/messaging mengarahkannya ke antrian tunda
 * berjenjang. Setelah tiga tingkat habis, ia masuk dead letter — dan pembungkus
 * consumer mencatatnya sebagai galat tingkat error, bukan peringatan, karena
 * refund yang tidak pernah selesai berarti uang pengguna tertahan.
 */
export class RefundUnavailableError extends AppError {
  constructor(paymentId: string, requestId: string) {
    super({
      code: 'REFUND_UNAVAILABLE',
      httpStatus: 502,
      message: `Penyedia pembayaran tidak dapat dihubungi untuk refund ${requestId}`,
      details: { paymentId, requestId },
    })
  }
}

/**
 * Penyedia menolak permintaan pembayaran.
 *
 * 402: permintaannya sah, tetapi pembayarannya tidak jadi. Pesannya tidak
 * memuat alasan dari penyedia — alasan itu masuk log dengan correlationId.
 * "Kartu ditolak karena limit" adalah informasi tentang pengguna yang tidak
 * perlu melewati batas sistem kita (NFR-15).
 */
export class PaymentRejectedError extends AppError {
  constructor() {
    super({
      code: 'PAYMENT_REJECTED',
      httpStatus: 402,
      message: 'Pembayaran tidak dapat diproses penyedia. Coba metode pembayaran lain.',
    })
  }
}

/**
 * Refund tidak akan pernah berhasil pada percobaan berikutnya.
 *
 * 409, jadi TIDAK dicoba ulang: langsung ke dead letter. Mencobanya lagi hanya
 * menghabiskan kuota percobaan sambil menunda perintah lain di belakangnya,
 * sementara yang dibutuhkan adalah manusia.
 */
export class RefundRefusedError extends AppError {
  constructor(paymentId: string, requestId: string, why: string) {
    super({
      code: 'REFUND_REFUSED',
      httpStatus: 409,
      message: `Refund ${requestId} tidak dapat diselesaikan: ${why}`,
      details: { paymentId, requestId, why },
    })
  }
}
