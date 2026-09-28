import { isFinal, type Booking } from '../domain/booking.js'
import { isSagaFinished, type SagaState } from '../domain/saga-state.js'
import { loadOwned } from './persist.js'
import type { BookingDeps } from './ports.js'

/**
 * Status pemesanan untuk pengguna yang menunggu (FR-26): GET /bookings/:id/status
 * dan aliran SSE-nya.
 *
 * Aliran dibangun dari pembacaan berkala, BUKAN dari pemberitahuan dalam
 * proses. Perubahan keadaan terjadi di consumer Kafka yang boleh berjalan di
 * instance booking-service lain (NFR-20); pemberitahuan dalam proses hanya
 * sampai ke pengguna yang kebetulan tersambung ke instance yang sama. LISTEN/
 * NOTIFY Postgres atau Redis pub/sub memperbaikinya dengan harga satu kanal
 * lagi yang dapat terputus diam-diam; pada skala ini, satu pembacaan kunci
 * primer per detik per pengguna yang menunggu lebih murah daripada kanal itu.
 */

export interface StatusSnapshot {
  readonly booking: Booking
  readonly saga: SagaState | undefined
}

export async function bookingStatus(
  deps: BookingDeps,
  userId: string,
  bookingId: string,
): Promise<StatusSnapshot | undefined> {
  const booking = await loadOwned(deps, userId, bookingId)
  if (booking === undefined) return undefined

  return { booking, saga: await deps.sagas.find(bookingId) }
}

/**
 * Tidak ada lagi yang akan berubah: pemesanan final DAN sagannya selesai —
 * atau tidak pernah punya saga. Pemesanan REFUNDED yang sagannya masih melepas
 * hold lokal belum selesai bagi pengguna yang menunggu kabar hold-nya.
 */
export function isSettled(snapshot: StatusSnapshot): boolean {
  const sagaDone = snapshot.saga === undefined || isSagaFinished(snapshot.saga)

  return isFinal(snapshot.booking.status) && sagaDone
}

export interface WatchOptions {
  readonly intervalMs: number
  /** Menunggu `ms`, atau berhenti lebih awal bila `signal` dibatalkan. */
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>
  readonly signal: AbortSignal
}

/**
 * Setiap PERUBAHAN status, dimulai dari keadaan sekarang, sampai pemesanan
 * tuntas atau penonton pergi. Perubahan dikenali dari versi pemesanan dan
 * versi saga — keduanya naik pada setiap perpindahan, jadi tidak ada
 * perubahan yang terlewat di antara dua pembacaan yang versinya sama.
 */
export async function* watchStatus(
  deps: BookingDeps,
  request: { readonly userId: string; readonly bookingId: string },
  options: WatchOptions,
): AsyncGenerator<StatusSnapshot> {
  let seen = ''

  while (!options.signal.aborted) {
    const snapshot = await bookingStatus(deps, request.userId, request.bookingId)
    if (snapshot === undefined) return

    const version = `${String(snapshot.booking.version)}/${String(snapshot.saga?.version ?? 0)}`
    if (version !== seen) {
      seen = version
      yield snapshot
    }
    if (isSettled(snapshot)) return

    await options.sleep(options.intervalMs, options.signal)
  }
}
