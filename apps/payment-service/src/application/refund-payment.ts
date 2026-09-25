import type { Money } from '@tbe/money'
import type { Refund, RefundReason, SettledPayment } from '../domain/payment.js'
import { requestRefund, settleRefund, type RefundRejection } from '../domain/refund.js'
import type { PaymentDeps } from './ports.js'

/**
 * Pengembalian dana, dipicu perintah `payment.refund` dari RabbitMQ.
 *
 * Perintah, bukan peristiwa: ada yang harus mengerjakannya, melaporkan
 * hasilnya, dan mencobanya lagi bila gagal — ketiganya tidak dimiliki aliran
 * peristiwa. Pemisahan itu ditegakkan bentuk API @tbe/messaging.
 *
 * Idempotensinya bertumpu pada `refundRequestId` dan ditegakkan di DUA tempat
 * yang berbeda, karena keduanya menjaga hal yang berbeda:
 *
 * - **Batasan UNIK pada `request_id`** menjaga terhadap balapan: sepuluh
 *   perintah yang tiba bersamaan hanya menghasilkan satu penyisipan, dan hanya
 *   pemenangnya yang menghubungi penyedia.
 * - **Pengenal yang sama diteruskan ke penyedia** menjaga terhadap apa yang
 *   sudah terjadi di sistem orang lain. Batasan UNIK kita tidak dapat
 *   membatalkan refund yang sudah dikirim ke Midtrans.
 *
 * Kegagalan sementara dikembalikan sebagai `retryable`, dan penangan consumer
 * yang melemparnya supaya percobaan berjenjang @tbe/messaging bekerja. Yang
 * habis percobaannya masuk dead letter dengan galat tingkat error — karena
 * refund yang tidak pernah selesai berarti uang pengguna tertahan.
 */

export interface RefundCommand {
  /** Pengenal permintaan refund. Idempotensi bertumpu padanya. */
  readonly refundRequestId: string
  readonly paymentId: string
  readonly bookingId: string
  readonly amount: Money
  readonly reason: RefundReason
}

export type RefundFailure =
  RefundRejection | 'unknown_payment' | 'gateway_rejected' | 'already_failed'

export type RefundResult =
  | { readonly kind: 'refunded'; readonly refund: Refund }
  /** Sudah pernah berhasil. Dikembalikan tanpa menghubungi penyedia. */
  | { readonly kind: 'already_done'; readonly refund: Refund }
  /** Sedang dikerjakan pihak lain — penyisipan ditolak batasan UNIK. */
  | { readonly kind: 'in_progress' }
  /** Gagal sementara. Penangan consumer melemparnya agar dicoba ulang. */
  | { readonly kind: 'retryable' }
  | { readonly kind: 'rejected'; readonly why: RefundFailure }

export async function refundPayment(
  deps: PaymentDeps,
  command: RefundCommand,
): Promise<RefundResult> {
  const payment = await deps.payments.findById(command.paymentId)

  if (payment === undefined) {
    // Uang pengguna tertahan dan tidak ada yang akan mengembalikannya sendiri.
    deps.logger.error(
      { paymentId: command.paymentId, bookingId: command.bookingId },
      'perintah refund menyebut pembayaran yang tidak dikenal',
    )

    return { kind: 'rejected', why: 'unknown_payment' }
  }

  const requested = requestRefund(payment, {
    id: deps.ids.next(),
    requestId: command.refundRequestId,
    amount: command.amount,
    reason: command.reason,
  })

  if (requested.kind === 'rejected') return reject(deps, command, requested.reason)
  if (requested.kind === 'already_requested') {
    return await resume(deps, requested.payment, requested.refund)
  }

  const inserted = await deps.payments.insertRefund(requested.payment, requested.refund)

  if (inserted.kind === 'conflict') {
    // Perintah lain menang. Menghubungi penyedia di sini berarti dana yang sama
    // dikembalikan dua kali — persis yang batasan UNIK dipasang untuk mencegah.
    deps.logger.info(
      { paymentId: payment.id, requestId: command.refundRequestId },
      'refund dengan pengenal yang sama sedang dikerjakan pihak lain',
    )

    return { kind: 'in_progress' }
  }

  return await callGateway(deps, requested.payment, requested.refund)
}

function reject(deps: PaymentDeps, command: RefundCommand, why: RefundRejection): RefundResult {
  const context = {
    paymentId: command.paymentId,
    bookingId: command.bookingId,
    requestId: command.refundRequestId,
    amountMinor: command.amount.amountMinor,
    why,
  }

  if (why === 'not_refundable') {
    // Dapat terjadi secara sah: saga mengompensasi pemesanan yang pembayarannya
    // memang belum pernah berhasil, dan pada keadaan itu tidak ada yang perlu
    // dikembalikan.
    deps.logger.warn(context, 'perintah refund pada pembayaran yang tidak dapat direfund')

    return { kind: 'rejected', why }
  }

  // Sisanya berarti perintah yang salah dari hulu — nilai melebihi pembayaran,
  // mata uang berbeda, nilai nol. Ketiganya cacat, bukan keadaan yang sah.
  deps.logger.error(context, 'perintah refund ditolak aturan domain')

  return { kind: 'rejected', why }
}

/**
 * Perintah yang tiba untuk refund yang sudah tercatat.
 *
 * Refund yang masih PENDING DILANJUTKAN, bukan ditolak sebagai duplikat. Tanpa
 * jalur ini, refund yang penyedianya sempat tidak dapat dihubungi akan terkunci
 * selamanya oleh pengenal permintaannya sendiri — dan uang pengguna tertahan
 * karena mekanisme yang dipasang untuk melindunginya.
 */
async function resume(
  deps: PaymentDeps,
  payment: SettledPayment,
  refund: Refund,
): Promise<RefundResult> {
  if (refund.status === 'SUCCEEDED') return { kind: 'already_done', refund }

  if (refund.status === 'FAILED') {
    deps.logger.warn(
      { paymentId: payment.id, requestId: refund.requestId },
      'perintah refund diulang untuk refund yang sudah gagal permanen',
    )

    return { kind: 'rejected', why: 'already_failed' }
  }

  return await callGateway(deps, payment, refund)
}

async function callGateway(
  deps: PaymentDeps,
  payment: SettledPayment,
  refund: Refund,
): Promise<RefundResult> {
  const result = await deps.gateway.refund({
    gatewayRef: payment.gatewayRef,
    requestId: refund.requestId,
    amount: refund.amount,
    reason: refund.reason,
  })

  if (result.kind === 'unavailable') {
    deps.logger.warn(
      { paymentId: payment.id, requestId: refund.requestId },
      'penyedia tidak dapat dihubungi untuk refund, perintah akan dicoba ulang',
    )

    // Refund dibiarkan PENDING. Kuotanya tetap terpakai supaya perintah lain
    // tidak ikut mengembalikan dana yang sama selagi yang ini menggantung.
    return { kind: 'retryable' }
  }

  const settled = settleRefund(
    payment,
    refund.requestId,
    result.kind === 'refunded'
      ? { kind: 'succeeded', gatewayRef: result.providerRef }
      : { kind: 'failed' },
  )

  if (settled.kind !== 'settled') {
    // Tidak dapat terjadi: refund baru saja ditemukan atau disisipkan. Dilempar,
    // bukan dikembalikan sebagai nilai — ini cacat program, bukan keadaan sah.
    throw new Error(`refund ${refund.requestId} hilang saat diselesaikan`)
  }

  // Keadaan LEBIH DULU, selalu.
  await deps.payments.updateRefund(settled.payment, settled.refund)

  return result.kind === 'rejected'
    ? refused(deps, settled.payment, settled.refund, result.reason)
    : await announce(deps, settled.payment, settled.refund)
}

/**
 * Penyedia menolak mengembalikan dana secara permanen.
 *
 * TIDAK ada peristiwa yang diterbitkan: `payment.refunded` berarti dana sudah
 * kembali, dan menerbitkannya di sini akan membuat pengguna diberi tahu bahwa
 * uangnya kembali padahal tidak.
 */
function refused(
  deps: PaymentDeps,
  payment: SettledPayment,
  refund: Refund,
  reason: string,
): RefundResult {
  // Uang pengguna tertahan dan tidak ada percobaan ulang yang akan mengubahnya.
  deps.logger.error(
    { paymentId: payment.id, requestId: refund.requestId, reason },
    'penyedia menolak refund secara permanen, butuh penanganan manusia',
  )

  return { kind: 'rejected', why: 'gateway_rejected' }
}

async function announce(
  deps: PaymentDeps,
  payment: SettledPayment,
  refund: Refund,
): Promise<RefundResult> {
  // Peristiwa SETELAH keadaan tersimpan. Consumer pemberitahuan (FR-23) membaca
  // ini untuk memberi tahu pengguna, dan memberi tahu lebih dulu berarti pengguna
  // diberi tahu tentang refund yang belum tercatat.
  await deps.events.refunded({
    refundId: refund.id,
    paymentId: payment.id,
    bookingId: payment.bookingId,
    amount: refund.amount,
  })

  deps.logger.info(
    {
      paymentId: payment.id,
      bookingId: payment.bookingId,
      requestId: refund.requestId,
      status: payment.status,
    },
    'dana dikembalikan',
  )

  return { kind: 'refunded', refund }
}
