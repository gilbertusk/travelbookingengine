import type { Booking, BookingIn } from '../../domain/booking.js'
import type { BookingDeps } from '../ports.js'
import { mustApply } from '../saga/reaction.js'

/**
 * Penyapu pembatalan (Step 25): jawaban yang tidak datang.
 *
 * Pembatalan yang menunggu melewati batas waktunya diserahkan ke manusia —
 * dari langkah mana pun, dan dengan alasan yang menyebut langkahnya:
 *
 * - **Supplier tidak menjawab.** Kamar MUNGKIN sudah lepas. Refund tidak
 *   dikirim (kamar yang masih terpesan ditambah uang yang kembali adalah
 *   kerugian ganda), dan pemesanan tidak dikembalikan ke CONFIRMED (kamar yang
 *   sudah lepas ditambah pemesanan yang tampak aktif adalah pengguna yang
 *   datang ke hotel tanpa kamar). Status supplier yang tidak pasti adalah
 *   urusan manusia, seperti US-05.
 * - **Refund tidak terkonfirmasi.** Kamar sudah lepas; uang pengguna belum
 *   terbukti kembali.
 */

export interface CancellationSweepReport {
  readonly reviewed: number
  readonly skipped: number
}

const REASONS = {
  supplier:
    'supplier tidak menjawab pembatalan sebelum batas waktu; status kamar tidak pasti, ' +
    'refund belum dikirim',
  refund: 'refund pembatalan tidak terkonfirmasi sebelum batas waktu; kamar sudah dibatalkan',
} as const

function isCancelling(booking: Booking): booking is BookingIn<'CANCELLING'> {
  return booking.status === 'CANCELLING'
}

export async function sweepCancellations(deps: BookingDeps): Promise<CancellationSweepReport> {
  const now = deps.clock.now()
  const report = { reviewed: 0, skipped: 0 }

  // Berurutan, seperti penyapu lain: jaring pengaman tidak bersaing dengan
  // permintaan pengguna untuk koneksi basis data.
  const overdue = await deps.bookings.findOverdueCancellations(now, deps.sagaPolicy.sweepBatch)
  for (const booking of overdue.filter(isCancelling)) {
    report[(await toReview(deps, booking, now)) ? 'reviewed' : 'skipped'] += 1
  }

  return report
}

/**
 * `false` bila pemesanan sudah bergerak sejak dibaca — jawabannya tiba
 * bersamaan dengan batas waktu, dan yang menang adalah jawabannya.
 */
async function toReview(
  deps: BookingDeps,
  booking: BookingIn<'CANCELLING'>,
  at: Date,
): Promise<boolean> {
  const reason = REASONS[booking.cancellationStage.step]
  const outcome = await deps.sagas.commit({
    bookingId: booking.id,
    at,
    change: mustApply(booking, { type: 'requireReview', at, reason }),
  })
  if (outcome !== 'committed') return false

  // Tingkat error: uang pengguna, kamar pengguna, atau keduanya, menunggu manusia.
  deps.logger.error(
    { bookingId: booking.id, step: booking.cancellationStage.step },
    `pembatalan diserahkan ke peninjauan: ${reason}`,
  )

  return true
}
