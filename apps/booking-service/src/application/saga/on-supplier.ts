import { completeSaga, toReview } from '../../domain/saga-state.js'
import type { BookingDeps } from '../ports.js'
import { voucherGenerate } from './commands.js'
import { compensate, compensationCommandFor } from './compensation.js'
import {
  mustApply,
  react,
  requireSaga,
  type Decision,
  type Reaction,
  type Situation,
} from './reaction.js'

/**
 * Reaksi saga terhadap jawaban supplier-service atas `supplier.confirm`
 * (Step 19). Tiga jawaban, tiga jalan:
 *
 * - `confirmed` → CONFIRMED, lalu voucher. Titik balik saga.
 * - `rejected` → FAILED, refund, lepas hold (US-03). Hanya diterbitkan untuk
 *   PENOLAKAN supplier yang sah setelah percobaan habis.
 * - `uncertain` → NEEDS_REVIEW, TANPA refund (US-05). Pemesanan mungkin sudah
 *   terbentuk di supplier; refund untuknya berarti platform membayar kamar
 *   yang uang penggunanya sudah dikembalikan.
 */

export interface SupplierConfirmed {
  readonly eventId: string
  readonly bookingId: string
  readonly supplierRef: string
}

export async function onSupplierConfirmed(
  deps: BookingDeps,
  event: SupplierConfirmed,
): Promise<Reaction> {
  const fact = {
    eventId: event.eventId,
    eventType: 'supplier.booking_confirmed',
    bookingId: event.bookingId,
  }

  return await react(deps, fact, async (situation) => {
    const { booking, saga, consumed, at } = situation

    if (booking.status === 'PAID') {
      return await deps.sagas.commit({
        bookingId: booking.id,
        at,
        change: mustApply(booking, { type: 'confirm', at, supplierRef: event.supplierRef }),
        saga: completeSaga(requireSaga(saga, booking), at),
        // issueVoucher: sesudah titik balik, maju saja. voucher-service
        // (Step 23) yang mengerjakannya; kegagalannya dicoba ulang di sana.
        commands: [voucherGenerate(booking.id)],
        consumed,
      })
    }

    if (booking.status === 'CONFIRMED' && booking.supplierRef === event.supplierRef) {
      return 'duplicate'
    }
    if (isAwaitingOrRefunding(booking.status)) return await lateConfirmation(deps, situation, event)

    return 'ignored'
  })
}

/** Keadaan tempat konfirmasi supplier yang tiba adalah fakta yang harus ditangani. */
function isAwaitingOrRefunding(status: string): boolean {
  return ['CONFIRMED', 'FAILED', 'REFUNDED', 'NEEDS_REVIEW'].includes(status)
}

/**
 * Konfirmasi yang tiba SETELAH saga memutuskan lain — perintah dari dead letter
 * yang diputar ulang operator, atau supplier yang mengabaikan kunci
 * idempotensinya dan membuat pemesanan kedua.
 *
 * Bila uang pengguna sedang atau sudah dikembalikan, pemesanan di supplier
 * harus dibatalkan: itulah kompensasi langkah `confirmSupplier` di tabel. Bila
 * uangnya TIDAK dikembalikan — peninjauan karena status tidak pasti — pemesanan
 * itu justru yang ditunggu pengguna, dan membatalkannya salah; faktanya
 * dicatat untuk peninjau.
 *
 * Keduanya berakhir di tangan manusia: pembatalan di supplier tidak punya
 * jalan balik ke saga, jadi keberhasilannya tidak dapat dipastikan di sini.
 */
async function lateConfirmation(
  deps: BookingDeps,
  situation: Situation,
  event: SupplierConfirmed,
): Promise<Decision> {
  const { booking, consumed, at } = situation
  const saga = requireSaga(situation.saga, booking)
  const log = { bookingId: booking.id, status: booking.status, supplierRef: event.supplierRef }

  if (booking.status === 'NEEDS_REVIEW' && booking.review.from === 'PAID') {
    const reason = `supplier ternyata mengonfirmasi (${event.supplierRef}); pemesanan ditinjau tanpa refund`
    deps.logger.error(log, reason)
    return await deps.sagas.commit({
      bookingId: booking.id,
      at,
      saga: toReview(saga, at, 'skipped', reason),
      consumed,
    })
  }

  const reason = `konfirmasi supplier ${event.supplierRef} tiba setelah saga memutuskan lain; dibatalkan di supplier`
  deps.logger.error(log, reason)
  return await deps.sagas.commit({
    bookingId: booking.id,
    at,
    commands: [
      compensationCommandFor('confirmSupplier', { booking, supplierRef: event.supplierRef }),
    ],
    saga: toReview(saga, at, 'failed', reason),
    consumed,
    ...(booking.status === 'FAILED'
      ? { change: mustApply(booking, { type: 'requireReview', at, reason }) }
      : {}),
  })
}

export interface SupplierRejected {
  readonly eventId: string
  readonly bookingId: string
  readonly reason: string
}

/** US-03: supplier gagal permanen setelah pembayaran. */
export async function onSupplierRejected(
  deps: BookingDeps,
  event: SupplierRejected,
): Promise<Reaction> {
  const fact = {
    eventId: event.eventId,
    eventType: 'supplier.booking_rejected',
    bookingId: event.bookingId,
  }

  return await react(deps, fact, async ({ booking, saga, consumed, at }) => {
    if (booking.status !== 'PAID') return 'ignored'

    const reason = `supplier menolak konfirmasi: ${event.reason}`
    deps.logger.warn({ bookingId: booking.id, reason: event.reason }, reason)

    return await compensate(deps, {
      booking,
      saga: requireSaga(saga, booking),
      change: mustApply(booking, { type: 'fail', at, reason }),
      consumed,
      start: { through: 'awaitPayment', stoppedAt: 'confirmSupplier', at, reason },
    })
  })
}

export interface SupplierUncertain {
  readonly eventId: string
  readonly bookingId: string
  readonly reason: string
}

/** US-05: status di supplier tidak dapat dipastikan. Peninjauan, BUKAN refund. */
export async function onSupplierUncertain(
  deps: BookingDeps,
  event: SupplierUncertain,
): Promise<Reaction> {
  const fact = {
    eventId: event.eventId,
    eventType: 'supplier.booking_uncertain',
    bookingId: event.bookingId,
  }

  return await react(deps, fact, async ({ booking, saga, consumed, at }) => {
    if (booking.status !== 'PAID') return 'ignored'

    const reason = `status pemesanan di supplier tidak dapat dipastikan: ${event.reason}`
    deps.logger.error({ bookingId: booking.id }, reason)

    return await deps.sagas.commit({
      bookingId: booking.id,
      at,
      change: mustApply(booking, { type: 'requireReview', at, reason }),
      saga: toReview(requireSaga(saga, booking), at, 'skipped', reason),
      consumed,
    })
  })
}
