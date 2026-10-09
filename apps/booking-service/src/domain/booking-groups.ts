import type { Booking, BookingStatus } from './booking.js'
import type { LocalDate } from './stay-dates.js'

/**
 * Kelompok di daftar pemesanan pengguna (Step 26, FR-25): akan datang,
 * selesai, dibatalkan.
 *
 * Pemesanan yang masih BERPROSES — menunggu pembayaran, menunggu supplier,
 * sedang dibatalkan, atau sedang diperiksa manusia — selalu di "akan datang",
 * apa pun tanggalnya. Pemesanan yang membutuhkan perhatian tidak boleh
 * tenggelam di arsip hanya karena tanggal keluarnya sudah lewat.
 *
 * DRAFT dan PRICE_CHECKED tidak masuk kelompok mana pun: itu harga yang
 * diperiksa, bukan pemesanan yang pernah dibuat pengguna.
 */

export const BOOKING_GROUPS = ['upcoming', 'past', 'cancelled'] as const
export type BookingGroup = (typeof BOOKING_GROUPS)[number]

export const IN_PROGRESS_STATUSES: BookingStatus[] = ['HELD', 'PAID', 'CANCELLING', 'NEEDS_REVIEW']

/** Berakhir tanpa menginap: dibatalkan, kedaluwarsa, gagal, atau dikembalikan. */
export const ENDED_WITHOUT_STAY_STATUSES: BookingStatus[] = [
  'CANCELLED',
  'EXPIRED',
  'FAILED',
  'REFUNDED',
]

/**
 * Kelompok satu pemesanan pada hari `today`.
 *
 * `today` adalah tanggal kalender UTC, bukan tanggal di properti. Batas
 * "selesai" bisa bergeser satu hari di sekitar tengah malam untuk properti
 * yang jauh dari UTC — dapat diterima untuk mengelompokkan daftar, dan sengaja
 * tidak dipakai untuk apa pun yang menyangkut uang.
 */
export function groupOf(booking: Booking, today: LocalDate): BookingGroup | undefined {
  if (IN_PROGRESS_STATUSES.includes(booking.status)) return 'upcoming'
  if (ENDED_WITHOUT_STAY_STATUSES.includes(booking.status)) return 'cancelled'
  if (booking.status !== 'CONFIRMED') return undefined

  return booking.stay.checkOut >= today ? 'upcoming' : 'past'
}
