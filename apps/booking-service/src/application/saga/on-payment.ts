import type { Money } from '@tbe/money'
import { isFinal, type Booking } from '../../domain/booking.js'
import {
  awaitOrphanRefund,
  awaitReply,
  orphanRefundSaga,
  refundSettled,
  toReview,
  type SagaState,
} from '../../domain/saga-state.js'
import { applyCommand } from '../../domain/transitions.js'
import type { BookingDeps } from '../ports.js'
import { refundPayment, supplierConfirm, type RefundReason } from './commands.js'
import { compensate } from './compensation.js'
import {
  mustApply,
  react,
  requireSaga,
  sagaIfChanged,
  type Decision,
  type Reaction,
  type Situation,
} from './reaction.js'

/**
 * Reaksi saga terhadap peristiwa payment-service (Step 19).
 *
 * Jaminan yang dijaga berkas ini: **tidak ada pembayaran berhasil tanpa
 * pemesanan terkonfirmasi atau refund.** Pembayaran yang diterima pemesanan
 * HELD melanjutkan saga ke konfirmasi supplier. Pembayaran yang TIDAK dapat
 * diterima — tiba setelah hold kedaluwarsa, setelah pembatalan, atau untuk
 * pemesanan yang sudah dibayar dengan pembayaran lain — dikembalikan. Menolak
 * mencatatnya tidak mengembalikan uangnya.
 */

export interface PaymentSucceeded {
  readonly eventId: string
  readonly bookingId: string
  readonly paymentId: string
  readonly amount: Money
}

export async function onPaymentSucceeded(
  deps: BookingDeps,
  event: PaymentSucceeded,
): Promise<Reaction> {
  const fact = {
    eventId: event.eventId,
    eventType: 'payment.succeeded',
    bookingId: event.bookingId,
  }

  return await react(deps, fact, async (situation) => {
    const { booking, saga, consumed, at } = situation
    const payment = { paymentId: event.paymentId, amount: event.amount }

    if (booking.status === 'HELD') {
      const change = applyCommand(booking, { type: 'recordPayment', at, ...payment })
      if (change.ok) {
        const deadline = new Date(at.getTime() + deps.sagaPolicy.confirmTimeoutMs)
        return await deps.sagas.commit({
          bookingId: booking.id,
          at,
          change: change.value,
          saga: awaitReply(requireSaga(saga, booking), 'confirmSupplier', at, deadline),
          // Dari pemesanan HELD, bukan PAID: hanya HELD yang membawa token hold.
          commands: [supplierConfirm(booking)],
          consumed,
        })
      }
    }

    // Pembayaran yang SAMA — pesan yang sama dengan eventId lain, diterbitkan
    // ulang payment-service. Efeknya sudah terjadi.
    if (booking.paymentId === event.paymentId) return 'duplicate'

    return await refundUnaccepted(deps, situation, payment)
  })
}

/**
 * Pembayaran yang tidak dapat diterima pemesanan dikembalikan.
 *
 * Refund itu dilacak saga bila pemesanannya sudah final — saga yang selesai
 * membuka diri lagi untuk menunggu konfirmasinya, dengan batas waktu. Bila
 * pemesanannya belum final, saga sedang menunggu hal lain dan satu batas waktu
 * tidak dapat menjaga dua hal: refund tetap dikirim, dan ketiadaan pelacakan
 * dicatat tingkat error, bukan disembunyikan.
 */
async function refundUnaccepted(
  deps: BookingDeps,
  situation: Situation,
  payment: { readonly paymentId: string; readonly amount: Money },
): Promise<Decision> {
  const { booking, consumed, at } = situation
  const due = new Date(at.getTime() + deps.sagaPolicy.awaitRefundTimeoutMs)
  const reason = `pembayaran ${payment.paymentId} tidak dapat diterima pemesanan ${booking.status}`
  const tracked = orphanTracking(situation, due, reason)

  const log = { bookingId: booking.id, paymentId: payment.paymentId, status: booking.status }
  if (tracked === undefined) {
    deps.logger.error(log, 'pembayaran dikembalikan TANPA pelacakan saga, periksa refundnya')
  } else {
    deps.logger.warn(log, 'pembayaran yang tidak dapat diterima pemesanan dikembalikan')
  }

  return await deps.sagas.commit({
    bookingId: booking.id,
    at,
    commands: [refundPayment(booking, payment, refundReasonFor(booking))],
    consumed,
    ...(tracked === undefined ? {} : { saga: tracked }),
  })
}

function orphanTracking(situation: Situation, due: Date, reason: string): SagaState | undefined {
  const { booking, saga, at } = situation
  if (!isFinal(booking.status)) return undefined

  return saga === undefined
    ? orphanRefundSaga(booking.id, at, due, reason)
    : awaitOrphanRefund(saga, at, due, reason)
}

/**
 * Alasan pada kontrak `payment.refund`. Kontrak hanya mengenal tiga, dan tidak
 * satu pun berbunyi "pemesanan tidak lagi dapat menerima pembayaran" — lihat
 * Temuan step doc 19. `manual` dipakai untuk semua yang bukan pembatalan oleh
 * pengguna.
 */
function refundReasonFor(booking: Booking): RefundReason {
  return booking.status === 'CANCELLED' && booking.cancellation === 'user_request'
    ? 'user_cancelled'
    : 'manual'
}

export interface PaymentFailed {
  readonly eventId: string
  readonly bookingId: string
  readonly reason: string
}

/** Pembayaran gagal setelah hold: hold dilepas, pemesanan CANCELLED (step doc 19). */
export async function onPaymentFailed(deps: BookingDeps, event: PaymentFailed): Promise<Reaction> {
  const fact = { eventId: event.eventId, eventType: 'payment.failed', bookingId: event.bookingId }

  return await react(deps, fact, async ({ booking, saga, consumed, at }) => {
    // Pembayaran gagal untuk pemesanan yang sudah bergerak — sudah dibayar
    // dengan percobaan lain, atau sudah kedaluwarsa — tidak mengubah apa pun.
    if (booking.status !== 'HELD') return 'ignored'

    return await compensate(deps, {
      booking,
      saga: requireSaga(saga, booking),
      change: mustApply(booking, { type: 'cancel', at, reason: 'payment_failed' }),
      consumed,
      start: {
        through: 'holdSupplier',
        stoppedAt: 'awaitPayment',
        at,
        reason: `pembayaran gagal: ${event.reason}`,
      },
    })
  })
}

export interface PaymentRefunded {
  readonly eventId: string
  readonly bookingId: string
  readonly paymentId: string
  readonly refundId: string
  readonly amount: Money
}

/** Refund tuntas: FAILED → REFUNDED, atau refund pembayaran yatim selesai dilacak. */
export async function onPaymentRefunded(
  deps: BookingDeps,
  event: PaymentRefunded,
): Promise<Reaction> {
  const fact = { eventId: event.eventId, eventType: 'payment.refunded', bookingId: event.bookingId }

  return await react(deps, fact, async (situation) => {
    const { booking, saga, consumed, at } = situation

    if (booking.status === 'FAILED' && booking.paymentId === event.paymentId) {
      return await settleCompensationRefund(deps, situation, event)
    }

    if (saga?.phase === 'compensating' && saga.refundDueBy !== undefined) {
      return await deps.sagas.commit({
        bookingId: booking.id,
        at,
        saga: refundSettled(saga, at),
        consumed,
      })
    }

    return 'ignored'
  })
}

async function settleCompensationRefund(
  deps: BookingDeps,
  situation: Situation,
  event: PaymentRefunded,
): Promise<Decision> {
  const { booking, consumed, at } = situation
  const saga = requireSaga(situation.saga, booking)
  const refunded = applyCommand(booking, {
    type: 'recordRefund',
    at,
    refundId: event.refundId,
    amount: event.amount,
  })

  if (refunded.ok) {
    const settled = refundSettled(saga, at)
    const unit = { bookingId: booking.id, at, change: refunded.value, consumed }
    return await deps.sagas.commit({ ...unit, ...sagaIfChanged(saga, settled) })
  }

  // Refund sebagian bukan akhir yang sah (Step 16): REFUNDED adalah klaim
  // bahwa SELURUH uang pengguna sudah kembali.
  const reason = `refund ${event.refundId} tidak sama dengan nilai yang ditagih`
  deps.logger.error({ bookingId: booking.id, refundId: event.refundId }, reason)
  return await deps.sagas.commit({
    bookingId: booking.id,
    at,
    change: mustApply(booking, { type: 'requireReview', at, reason }),
    saga: toReview(saga, at, 'failed', reason),
    consumed,
  })
}
