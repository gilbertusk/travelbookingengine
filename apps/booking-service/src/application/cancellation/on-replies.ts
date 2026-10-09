import { format, isZero, type Money } from '@tbe/money'
import type { BookingIn } from '../../domain/booking.js'
import { applyCommand } from '../../domain/transitions.js'
import type { BookingDeps } from '../ports.js'
import { mustApply, react, type Decision, type Reaction, type Situation } from '../saga/reaction.js'
import { cancellationRefund, cancellationRefundRequestId } from './commands.js'

/**
 * Reaksi saga pembatalan terhadap jawaban supplier-service dan payment-service
 * (Step 25).
 *
 * Dua kompensasi yang dijaga di sini, dan keduanya berupa apa yang TIDAK
 * dilakukan:
 *
 * - **Supplier gagal membatalkan → tidak ada refund.** Kamar masih terpesan;
 *   mengembalikan uangnya berarti kerugian ganda. Pemesanan kembali
 *   CONFIRMED, dan pengguna dapat mencoba membatalkan lagi.
 * - **Refund gagal setelah supplier membatalkan → pembatalan supplier TIDAK
 *   dibalik.** Pemesanan ke NEEDS_REVIEW dengan galat tingkat error: uang
 *   pengguna tertahan, kamarnya sudah lepas, dan hanya manusia yang dapat
 *   menyelesaikannya.
 *
 * Jawaban untuk pemesanan yang tidak sedang menunggunya diabaikan. Pembatalan
 * di supplier juga dipakai kompensasi saga pemesanan (Step 19), dan jawabannya
 * terbit lewat topik yang sama.
 */

interface SupplierReply {
  readonly eventId: string
  readonly bookingId: string
  readonly supplierRef: string
}

/** Pemesanan yang sedang menunggu jawaban supplier atas booking reference ini. */
function awaitingSupplier(
  situation: Situation,
  supplierRef: string,
): BookingIn<'CANCELLING'> | undefined {
  const { booking } = situation
  if (booking.status !== 'CANCELLING' || booking.cancellationStage.step !== 'supplier') {
    return undefined
  }

  return booking.supplierRef === supplierRef ? booking : undefined
}

/** supplier.booking_cancelled: kamar lepas. Refund dikirim — atau, tanpa dana kembali, selesai. */
export async function onSupplierCancelled(
  deps: BookingDeps,
  event: SupplierReply,
): Promise<Reaction> {
  const fact = {
    eventId: event.eventId,
    eventType: 'supplier.booking_cancelled',
    bookingId: event.bookingId,
  }

  return await react(deps, fact, async (situation) => {
    const booking = awaitingSupplier(situation, event.supplierRef)
    if (booking === undefined) return 'ignored'

    const { consumed, at } = situation
    const unit = { bookingId: booking.id, at, consumed }

    if (isZero(booking.cancellationRequest.refund)) {
      return await deps.sagas.commit({
        ...unit,
        change: mustApply(booking, {
          type: 'completeCancellation',
          at,
          settlement: { kind: 'nothing_due' },
        }),
      })
    }

    const refundBy = new Date(at.getTime() + deps.sagaPolicy.awaitRefundTimeoutMs)
    const change = mustApply(booking, { type: 'confirmSupplierCancellation', at, refundBy })

    return await deps.sagas.commit({
      ...unit,
      change,
      // Sebesar persetujuan saat pembatalan diminta — bukan dihitung ulang
      // terhadap jam sekarang, yang mungkin sudah melewati jenjangnya.
      commands: [cancellationRefund(booking)],
    })
  })
}

/**
 * supplier.booking_cancel_failed. Dua jawaban, dua akhir:
 *
 * - `refused`: supplier menolak, kamar pasti masih terpesan. Pemesanan kembali
 *   CONFIRMED, tanpa refund, dan pengguna dapat mencoba lagi.
 * - `uncertain`: kamar MUNGKIN sudah lepas. Tidak ada refund (kamar yang masih
 *   terpesan ditambah uang yang kembali adalah kerugian ganda), dan tidak
 *   kembali ke CONFIRMED (pemesanan yang tampak aktif untuk kamar yang sudah
 *   tidak ada). Diserahkan ke manusia, seperti US-05.
 */
export async function onSupplierCancelFailed(
  deps: BookingDeps,
  event: SupplierReply & { readonly outcome: 'refused' | 'uncertain'; readonly reason: string },
): Promise<Reaction> {
  const fact = {
    eventId: event.eventId,
    eventType: 'supplier.booking_cancel_failed',
    bookingId: event.bookingId,
  }

  return await react(deps, fact, async (situation) => {
    const booking = awaitingSupplier(situation, event.supplierRef)
    if (booking === undefined) return 'ignored'

    const { consumed, at } = situation
    const log = { bookingId: booking.id, supplierRef: event.supplierRef, reason: event.reason }
    const change =
      event.outcome === 'refused'
        ? mustApply(booking, {
            type: 'restoreConfirmation',
            at,
            reason: `supplier menolak pembatalan: ${event.reason}`,
          })
        : mustApply(booking, {
            type: 'requireReview',
            at,
            reason: `status pembatalan di supplier tidak pasti: ${event.reason}; refund belum dikirim`,
          })

    // Tingkat error untuk keduanya: pengguna meminta pembatalan dan tidak
    // mendapatkannya, dan seseorang perlu tahu kenapa.
    deps.logger.error(
      log,
      event.outcome === 'refused'
        ? 'supplier menolak pembatalan, pemesanan kembali terkonfirmasi tanpa refund'
        : 'pembatalan di supplier tidak pasti, diserahkan ke peninjauan tanpa refund',
    )

    return await deps.sagas.commit({ bookingId: booking.id, at, consumed, change })
  })
}

/** Pemesanan yang sedang menunggu refund pembatalan untuk pembayaran ini. */
export function awaitingRefund(
  situation: Situation,
  paymentId: string,
): BookingIn<'CANCELLING'> | undefined {
  const { booking } = situation
  if (booking.status !== 'CANCELLING' || booking.cancellationStage.step !== 'refund') {
    return undefined
  }

  return booking.paymentId === paymentId ? booking : undefined
}

/**
 * payment.refunded untuk pembatalan: tuntas. Refund dengan nilai lain dari
 * persetujuan bukan penyelesaian pembatalan ini — diserahkan ke manusia.
 */
export async function settleCancellationRefund(
  deps: BookingDeps,
  situation: Situation,
  booking: BookingIn<'CANCELLING'>,
  refund: { readonly refundId: string; readonly amount: Money },
): Promise<Decision> {
  const { consumed, at } = situation
  const settled = applyCommand(booking, {
    type: 'completeCancellation',
    at,
    settlement: { kind: 'refunded', refundId: refund.refundId, amount: refund.amount },
  })
  const unit = { bookingId: booking.id, at, consumed }

  if (settled.ok) return await deps.sagas.commit({ ...unit, change: settled.value })

  const reason =
    `refund pembatalan ${refund.refundId} sebesar ${format(refund.amount)} tidak sama ` +
    `dengan yang disetujui (${format(booking.cancellationRequest.refund)})`
  deps.logger.error({ bookingId: booking.id, refundId: refund.refundId }, reason)

  return await deps.sagas.commit({
    ...unit,
    change: mustApply(booking, { type: 'requireReview', at, reason }),
  })
}

export interface RefundFailed {
  readonly eventId: string
  readonly bookingId: string
  readonly paymentId: string
  readonly refundRequestId: string
  readonly amount: Money
  readonly reason: string
}

/** payment.refund_failed untuk refund pembatalan: kamar sudah lepas, uang tertahan. */
export async function onRefundFailed(deps: BookingDeps, event: RefundFailed): Promise<Reaction> {
  const fact = {
    eventId: event.eventId,
    eventType: 'payment.refund_failed',
    bookingId: event.bookingId,
  }

  return await react(deps, fact, async (situation) => {
    const booking = awaitingRefund(situation, event.paymentId)
    // Refund lain untuk pemesanan yang sama — kompensasi Step 19 — punya
    // pengenal permintaan sendiri dan dijaga batas waktunya sendiri.
    if (
      booking === undefined ||
      event.refundRequestId !== cancellationRefundRequestId(booking.id, booking.paymentId)
    ) {
      return 'ignored'
    }

    const { consumed, at } = situation
    const reason =
      `refund pembatalan ${format(event.amount)} gagal: ${event.reason}; ` +
      'pemesanan sudah dibatalkan di supplier'
    // Tingkat error: uang pengguna tertahan dan tidak ada yang akan
    // mengembalikannya sendiri. Pembatalan di supplier TIDAK dibalik.
    deps.logger.error({ bookingId: booking.id, paymentId: event.paymentId }, reason)

    return await deps.sagas.commit({
      bookingId: booking.id,
      at,
      consumed,
      change: mustApply(booking, { type: 'requireReview', at, reason }),
    })
  })
}
