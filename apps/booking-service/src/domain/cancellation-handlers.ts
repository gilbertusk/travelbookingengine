import { compare, isNegative, isZero } from '@tbe/money'
import { ok } from '@tbe/shared-kernel'
import type { BookingIn } from './booking.js'
import { isBlank, meta, next, violation, type Handler } from './handlers.js'
import { isSameAmount } from './price.js'

/**
 * Handler pembatalan oleh pengguna (Step 25, FR-27).
 *
 * Saga kedua sistem ini, dalam empat perintah:
 *
 *   CONFIRMED  ─requestCancellation→          CANCELLING (menunggu supplier)
 *   CANCELLING ─confirmSupplierCancellation→  CANCELLING (menunggu refund)
 *   CANCELLING ─completeCancellation→         CANCELLED
 *   CANCELLING ─restoreConfirmation→          CONFIRMED  (supplier gagal membatalkan)
 *   CANCELLING ─requireReview→                NEEDS_REVIEW (refund gagal)
 *
 * Urutannya — kamar dilepas DULU, uang kembali KEMUDIAN — adalah seluruh
 * kompensasinya. Mengembalikan uang untuk kamar yang masih terpesan adalah
 * kerugian ganda, jadi refund tidak pernah dikirim sebelum supplier menjawab;
 * dan pembatalan supplier yang sudah terjadi tidak pernah "dibatalkan balik"
 * ketika refundnya gagal — uang pengguna tertahan, dan itu urusan manusia.
 *
 * Seperti handlers.ts, tidak ada pemeriksaan keadaan di sini — tabel transisi
 * yang memutuskan. Yang diperiksa adalah LANGKAH di dalam CANCELLING, karena
 * perintah yang sama sah pada keadaan itu tetapi bermakna hanya pada langkah
 * tertentu.
 */

export const requestCancellation: Handler<BookingIn<'CONFIRMED'>, 'requestCancellation'> = (
  booking,
  command,
) => {
  const { refund } = command.quote
  const paid = booking.price.total

  if (refund.currency !== paid.currency || isNegative(refund) || compare(refund, paid) > 0) {
    return violation(
      booking,
      'refund_exceeds_payment',
      'Nilai pengembalian melebihi pembayaran atau berbeda mata uang',
    )
  }
  if (command.replyBy.getTime() <= command.at.getTime()) {
    return violation(booking, 'deadline_in_past', 'Batas menunggu supplier sudah lewat')
  }

  const base = next(booking, command.at)
  const request = { refund, percent: command.quote.percent, requestedAt: command.at }

  return ok({
    booking: {
      ...base,
      status: 'CANCELLING',
      paymentId: booking.paymentId,
      supplierRef: booking.supplierRef,
      cancellationRequest: request,
      cancellationStage: { step: 'supplier', deadlineAt: command.replyBy },
    },
    event: {
      type: 'CancellationRequested',
      ...meta(base),
      paymentId: booking.paymentId,
      supplierRef: booking.supplierRef,
      quote: command.quote,
      replyBy: command.replyBy,
    },
  })
}

export const confirmSupplierCancellation: Handler<
  BookingIn<'CANCELLING'>,
  'confirmSupplierCancellation'
> = (booking, command) => {
  if (booking.cancellationStage.step !== 'supplier') {
    return violation(booking, 'cancellation_stage_mismatch', 'Supplier sudah pernah menjawab')
  }
  // Tanpa dana yang kembali, tidak ada refund untuk ditunggu: pembatalan
  // langsung tuntas lewat completeCancellation.
  if (isZero(booking.cancellationRequest.refund)) {
    return violation(booking, 'refund_due_mismatch', 'Tidak ada dana yang perlu dikembalikan')
  }
  if (command.refundBy.getTime() <= command.at.getTime()) {
    return violation(booking, 'deadline_in_past', 'Batas menunggu refund sudah lewat')
  }

  const base = next(booking, command.at)

  return ok({
    booking: {
      ...base,
      status: 'CANCELLING',
      paymentId: booking.paymentId,
      supplierRef: booking.supplierRef,
      cancellationRequest: booking.cancellationRequest,
      cancellationStage: { step: 'refund', deadlineAt: command.refundBy },
    },
    event: {
      type: 'SupplierCancellationConfirmed',
      ...meta(base),
      supplierRef: booking.supplierRef,
      refund: booking.cancellationRequest.refund,
      refundBy: command.refundBy,
    },
  })
}

/**
 * Pembatalan tuntas.
 *
 * - `nothing_due`: supplier sudah membatalkan dan jadwal tidak mengembalikan
 *   apa pun. Hanya sah dari langkah `supplier` dengan nilai nol.
 * - `refunded`: refund tuntas. Hanya sah dari langkah `refund`, dengan nilai
 *   yang SAMA dengan yang disetujui — refund dengan nilai lain bukan
 *   penyelesaian pembatalan ini, melainkan sesuatu yang harus diperiksa.
 */
export const completeCancellation: Handler<BookingIn<'CANCELLING'>, 'completeCancellation'> = (
  booking,
  command,
) => {
  const { settlement } = command
  const request = booking.cancellationRequest
  const step = booking.cancellationStage.step

  if (settlement.kind === 'nothing_due') {
    if (step !== 'supplier') {
      return violation(booking, 'cancellation_stage_mismatch', 'Refund sudah dikirim')
    }
    if (!isZero(request.refund)) {
      return violation(booking, 'refund_due_mismatch', 'Ada dana yang wajib dikembalikan')
    }
  } else {
    if (step !== 'refund') {
      return violation(booking, 'cancellation_stage_mismatch', 'Supplier belum membatalkan')
    }
    if (isBlank(settlement.refundId)) {
      return violation(booking, 'blank_field', 'Pengenal refund kosong')
    }
    if (!isSameAmount(settlement.amount, request.refund)) {
      return violation(booking, 'amount_mismatch', 'Nilai refund berbeda dari yang disetujui')
    }
  }

  const base = next(booking, command.at)
  const settled =
    settlement.kind === 'nothing_due'
      ? ({ kind: 'nothing_due' } as const)
      : ({ kind: 'refunded', refundId: settlement.refundId } as const)

  return ok({
    booking: {
      ...base,
      status: 'CANCELLED',
      cancellation: 'user_request',
      paymentId: booking.paymentId,
      supplierRef: booking.supplierRef,
      cancellationRequest: request,
      cancellationSettlement: settled,
    },
    event: {
      type: 'CancellationCompleted',
      ...meta(base),
      paymentId: booking.paymentId,
      supplierRef: booking.supplierRef,
      refund: request.refund,
      settlement: settled,
    },
  })
}

/**
 * Supplier tidak dapat membatalkan: kamar masih terpesan, dan pemesanan
 * kembali CONFIRMED dengan booking reference yang sama. Hanya dari langkah
 * `supplier` — setelah kamar lepas, tidak ada CONFIRMED untuk dikembalikan.
 */
export const restoreConfirmation: Handler<BookingIn<'CANCELLING'>, 'restoreConfirmation'> = (
  booking,
  command,
) => {
  if (booking.cancellationStage.step !== 'supplier') {
    return violation(booking, 'cancellation_stage_mismatch', 'Kamar sudah dibatalkan di supplier')
  }
  if (isBlank(command.reason)) return violation(booking, 'blank_field', 'Alasan kegagalan kosong')

  const base = next(booking, command.at)

  return ok({
    booking: {
      ...base,
      status: 'CONFIRMED',
      paymentId: booking.paymentId,
      supplierRef: booking.supplierRef,
    },
    event: {
      type: 'CancellationRestored',
      ...meta(base),
      supplierRef: booking.supplierRef,
      reason: command.reason,
    },
  })
}
