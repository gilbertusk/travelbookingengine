import { definitionOf } from '../../domain/saga-definition.js'
import { renewLease, toReview, type SagaState } from '../../domain/saga-state.js'
import type { BookingDeps } from '../ports.js'
import { compensate, runDirectCompensations } from './compensation.js'
import { mustApply } from './reaction.js'

/**
 * Penyapu saga: batas waktu dan pemulihan (Step 19). Dijalankan SEKALI saat
 * startup — sebelum HTTP menerima permintaan — lalu berkala.
 *
 * Dua sumber, masing-masing dengan indeksnya:
 *
 * 1. **Batas menunggu yang lewat.** Jawaban yang tidak datang tidak akan
 *    datang dengan menunggu lebih lama; tanpa batas ini, setiap saga yang
 *    kehilangan satu pesan menggantung selamanya (NFR-06).
 * 2. **Sewa proses yang lewat.** Langkah langsung dicatat SEBELUM dijalankan,
 *    bersama sewanya. Sewa yang habis berarti prosesnya mati di tengah
 *    langkah — atau sangat lambat, dan kunci versi memastikan ia kalah bila
 *    kembali.
 *
 * Kenapa sewa, bukan "semua yang tertinggal saat startup": beberapa instance
 * booking-service berjalan bersamaan (NFR-20). Saat satu instance menyala,
 * saga yang sedang dikerjakan instance lain juga tampak "tertinggal". Sewa
 * membedakan yang ditinggal dari yang sedang dikerjakan.
 */

export interface SagaSweepReport {
  readonly timedOut: number
  readonly recovered: number
  readonly failed: number
}

export async function sweepSagas(deps: BookingDeps): Promise<SagaSweepReport> {
  const now = deps.clock.now()
  const batch = deps.sagaPolicy.sweepBatch
  const report = { timedOut: 0, recovered: 0, failed: 0 }

  // Berurutan, seperti penyapu hold Step 17: jaring pengaman tidak boleh
  // bersaing dengan permintaan pengguna untuk koneksi basis data.
  for (const saga of await deps.sagas.findDue(now, batch)) {
    const handled = await guarded(deps, saga, async () => {
      await handleDeadline(deps, saga)
    })
    report[handled ? 'timedOut' : 'failed'] += 1
  }
  for (const saga of await deps.sagas.findLeaseExpired(now, batch)) {
    const handled = await guarded(deps, saga, async () => {
      await recoverSaga(deps, saga)
    })
    report[handled ? 'recovered' : 'failed'] += 1
  }

  return report
}

/**
 * Satu saga yang gagal ditangani tidak menghentikan putaran untuk saga lain.
 * Galatnya dicatat tingkat error — ini jaring pengaman terakhir — dan saga itu
 * tetap terlihat oleh kueri yang sama pada putaran berikutnya.
 */
async function guarded(
  deps: BookingDeps,
  saga: SagaState,
  work: () => Promise<void>,
): Promise<boolean> {
  try {
    await work()
    return true
  } catch (error) {
    deps.logger.error(
      { err: error, bookingId: saga.bookingId },
      'penyapu saga gagal menangani saga',
    )
    return false
  }
}

/** Batas waktu lewat: jawaban supplier atau konfirmasi refund tidak datang. */
export async function handleDeadline(deps: BookingDeps, saga: SagaState): Promise<void> {
  const booking = await deps.bookings.findById(saga.bookingId)
  if (booking === undefined) throw new Error(`saga ${saga.bookingId} tanpa pemesanan`)
  const at = deps.clock.now()

  if (saga.phase === 'running' && booking.status === 'PAID') {
    // US-05: tidak ada jawaban BUKAN penolakan. Supplier mungkin sudah
    // membuat pemesanannya; refund sekarang adalah refund membabi buta.
    const reason =
      'tidak ada jawaban supplier.confirm dalam batas waktu; status supplier tidak pasti'
    deps.logger.error({ bookingId: booking.id }, reason)
    await deps.sagas.commit({
      bookingId: booking.id,
      at,
      change: mustApply(booking, { type: 'requireReview', at, reason }),
      saga: toReview(saga, at, 'skipped', reason),
    })
    return
  }

  if (saga.phase === 'compensating') {
    // Kegagalan kompensasi TIDAK diabaikan: refund yang tidak terkonfirmasi
    // adalah uang pengguna yang mungkin tertahan.
    const reason = 'refund tidak terkonfirmasi dalam batas waktu; kompensasi gagal'
    deps.logger.error({ bookingId: booking.id, status: booking.status }, reason)
    await deps.sagas.commit({
      bookingId: booking.id,
      at,
      saga: toReview(saga, at, 'failed', reason),
      ...(booking.status === 'FAILED'
        ? { change: mustApply(booking, { type: 'requireReview', at, reason }) }
        : {}),
    })
    return
  }

  throw new Error(`batas waktu saga ${saga.bookingId} (${saga.phase}) tanpa penantian yang dikenal`)
}

/**
 * Sewa lewat: proses yang mencatat niatnya mati sebelum menyelesaikannya.
 *
 * - Langkah maju yang hasilnya tidak diketahui DIKOMPENSASI seolah berhasil
 *   bila langkah itu tidak boleh diulang — kursi mungkin sudah diambil, hold
 *   supplier mungkin sudah terbentuk. Kompensasinya idempoten, jadi membalik
 *   efek yang ternyata tidak pernah terjadi tidak merusak apa pun. Pengguna
 *   mengulang hold-nya sendiri; saga tidak menahan kamar atas nama pengguna
 *   yang sudah pergi.
 * - Kompensasi langsung yang terhenti DILANJUTKAN — setelah sewa baru dicatat
 *   lebih dulu, supaya dua pemulih tidak menjalankannya bersamaan.
 */
export async function recoverSaga(deps: BookingDeps, saga: SagaState): Promise<void> {
  const booking = await deps.bookings.findById(saga.bookingId)
  if (booking === undefined) throw new Error(`saga ${saga.bookingId} tanpa pemesanan`)
  const at = deps.clock.now()

  if (saga.phase === 'running') {
    if (definitionOf(saga.step).retryable) {
      throw new Error(`langkah ${saga.step} boleh diulang, tetapi tidak pernah dijalankan langsung`)
    }
    deps.logger.warn(
      { bookingId: booking.id, step: saga.step },
      'saga dipulihkan: langkah dikompensasi',
    )
    await compensate(deps, {
      booking,
      saga,
      start: {
        through: saga.step,
        stoppedAt: saga.step,
        at,
        reason: `proses mati di tengah langkah ${saga.step}; hasilnya tidak diketahui`,
      },
    })
    return
  }

  const claimed = renewLease(saga, at, deps.sagaPolicy.leaseMs)
  if (claimed === saga) return
  if ((await deps.sagas.commit({ bookingId: booking.id, at, saga: claimed })) !== 'committed')
    return

  deps.logger.warn(
    { bookingId: booking.id, step: saga.step },
    'saga dipulihkan: kompensasi dilanjutkan',
  )
  await runDirectCompensations(deps, booking, claimed)
}
