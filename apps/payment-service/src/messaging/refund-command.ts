import type { CommandPayload } from '@tbe/event-contracts'
import { money } from '@tbe/money'
import type { PaymentDeps } from '../application/ports.js'
import { refundPayment, type RefundResult } from '../application/refund-payment.js'
import { RefundRefusedError, RefundUnavailableError } from '../domain/errors.js'

/**
 * Penangan perintah `payment.refund` dari RabbitMQ.
 *
 * Tidak ada logika bisnis di sini — seluruhnya di application/refund-payment.ts,
 * yang juga dipakai jalur lain. Yang diputuskan di berkas ini hanya satu hal,
 * dan itu keputusan yang penting: **apa yang dilempar.**
 *
 * Pembungkus consumer @tbe/messaging membaca lemparan itu untuk memutuskan
 * antara antrian tunda dan dead letter:
 *
 * - `retryable` → dilempar sebagai galat 502. Masuk antrian tunda berjenjang
 *   (5 detik, 30 detik, 2 menit), dan setelah habis ke dead letter dengan galat
 *   tingkat ERROR — bukan peringatan. Refund yang tidak pernah selesai berarti
 *   uang pengguna tertahan, dan itu butuh manusia.
 * - penolakan permanen → dilempar sebagai galat 409. Langsung ke dead letter,
 *   tanpa percobaan ulang. Mencobanya lagi tidak akan mengubah jawabannya.
 * - selesai, duplikat, atau tidak ada yang perlu dikembalikan → TIDAK dilempar.
 *   Perintah di-ack, karena pekerjaannya memang sudah tidak ada.
 */

export function handleRefund(deps: PaymentDeps) {
  return async (payload: CommandPayload<'payment.refund'>): Promise<void> => {
    const result = await refundPayment(deps, {
      refundRequestId: payload.refundRequestId,
      paymentId: payload.paymentId,
      bookingId: payload.bookingId,
      amount: money(payload.amount.amountMinor, payload.amount.currency),
      reason: payload.reason,
    })

    raiseIfUnfinished(result, payload)
  }
}

function raiseIfUnfinished(result: RefundResult, payload: CommandPayload<'payment.refund'>): void {
  if (result.kind === 'retryable') {
    throw new RefundUnavailableError(payload.paymentId, payload.refundRequestId)
  }

  if (result.kind !== 'rejected') return

  /**
   * Dua penolakan yang TIDAK dilempar, dan keduanya disengaja:
   *
   * - `not_refundable`: pembayarannya memang belum pernah berhasil. Saga yang
   *   mengompensasi pemesanan yang pembayarannya gagal akan mengirim perintah
   *   ini, dan tidak ada yang perlu dikembalikan. Melemparnya membuat dead
   *   letter penuh oleh pekerjaan yang benar-benar tidak ada.
   * - `already_failed`: sudah pernah gagal permanen dan sudah pernah masuk dead
   *   letter. Melemparnya lagi hanya menggandakan catatan yang sama.
   */
  if (result.why === 'not_refundable' || result.why === 'already_failed') return

  throw new RefundRefusedError(payload.paymentId, payload.refundRequestId, result.why)
}
