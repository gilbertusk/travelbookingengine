import type { Booking } from '../domain/booking.js'
import type { SagaState } from '../domain/saga-state.js'
import type { SagaStore } from './ports.js'
import { supplierIdempotencyKey } from './saga/commands.js'

/**
 * Antrean tinjauan NEEDS_REVIEW untuk panel operator (Step 27).
 *
 * NEEDS_REVIEW tanpa halaman ini hanyalah tempat pembuangan: saga berhenti
 * dengan benar (US-05), lalu tidak ada yang dapat melihat KENAPA. Yang
 * dibutuhkan manusia untuk memutuskan ada di tiga tempat, dan ketiganya
 * dikumpulkan di sini atau ditunjuk dari sini:
 *
 * 1. Jejak booking_events — urutan transisi, termasuk alasan setiap kegagalan.
 * 2. Keadaan saga — langkah tempat ia berhenti, percobaan, galat terakhir.
 * 3. Catatan permintaan supplier dan status pembayaran — milik service lain.
 *    Booking-service TIDAK memanggil keduanya; ia mengembalikan kunci untuk
 *    mencarinya (`supplierIdempotencyKey`, `paymentId`) dan panel operator
 *    yang merangkai. Service yang memanggil dua service lain hanya untuk
 *    halaman operator akan menambah dua ketergantungan pada jalur yang
 *    seharusnya hanya membaca basis datanya sendiri.
 *
 * Halaman ini HANYA membaca. Tindakan atas pemesanan yang ditinjau
 * (konfirmasi manual, refund manual) belum ada — lihat Temuan Step 27.
 */

export interface AuditEntry {
  readonly sequence: number
  readonly type: string
  readonly occurredAt: Date
  /** Payload apa adanya dari booking_events: untuk dibaca manusia, bukan diurai. */
  readonly payload: unknown
}

/** Port pembacaan untuk antrean. Dipisah dari BookingRepository: jalur tulis tidak membutuhkannya. */
export interface ReviewReader {
  /** Yang paling LAMA menunggu lebih dulu — uang pengguna yang tertahan paling lama. */
  needingReview(limit: number): Promise<readonly Booking[]>
  auditTrail(bookingId: string, limit: number): Promise<readonly AuditEntry[]>
}

export interface ReviewDeps {
  readonly reviews: ReviewReader
  readonly sagas: Pick<SagaStore, 'find'>
}

export interface ReviewCase {
  readonly booking: Booking
  readonly trail: readonly AuditEntry[]
  readonly saga: SagaState | undefined
  readonly supplierIdempotencyKey: string
}

/** Batas jejak per pemesanan. Satu pemesanan lengkap dengan pembatalan kurang dari dua puluh. */
export const MAX_TRAIL = 200

export async function reviewQueue(deps: ReviewDeps, limit: number): Promise<readonly ReviewCase[]> {
  const bookings = await deps.reviews.needingReview(limit)

  return await Promise.all(bookings.map(async (booking) => await reviewCase(deps, booking)))
}

export async function reviewCase(deps: ReviewDeps, booking: Booking): Promise<ReviewCase> {
  const [trail, saga] = await Promise.all([
    deps.reviews.auditTrail(booking.id, MAX_TRAIL),
    deps.sagas.find(booking.id),
  ])

  return { booking, trail, saga, supplierIdempotencyKey: supplierIdempotencyKey(booking.id) }
}
