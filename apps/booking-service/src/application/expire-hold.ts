import type { Booking } from '../domain/booking.js'
import { persist } from './persist.js'
import { slotOf } from './place-hold.js'
import type { BookingDeps } from './ports.js'

/**
 * Pelepasan hold yang kedaluwarsa (FR-16).
 *
 * SATU fungsi untuk dua jalur: keyspace notification Redis dan penyapu
 * berkala. Keduanya boleh berjalan bersamaan untuk pemesanan yang sama, dan
 * itu aman karena dua hal, bukan karena keberuntungan:
 *
 * - Perpindahan ke EXPIRED dijaga kunci versi. Dari dua jalur yang membaca
 *   versi yang sama, tepat satu yang tersimpan; yang lain menerima keadaan
 *   pemenang dan berhenti.
 * - Pelepasan hold lokal idempoten di dalam skrip Lua: hanya pemanggil yang
 *   benar-benar mengeluarkan pemesanan dari slot yang mengembalikan kursinya.
 *
 * Urutannya: basis data dulu, Redis sesudahnya. Kebalikannya membuka jendela
 * di mana kursi sudah kembali ke slot sementara pemesanan masih HELD — satu
 * kursi dijual dua kali di lapis lokal. Dengan urutan ini, proses yang mati di
 * antara keduanya meninggalkan kursi yang tertahan tanpa pemilik, dan kursi
 * itu yang dicari penyapu lewat [HoldStore.orphans].
 *
 * Hold di supplier tidak dilepaskan — tidak ada operasinya. Ia kedaluwarsa
 * sendiri, paling lambat bersamaan dengan hold lokal, karena `heldUntil` adalah
 * yang lebih awal di antara keduanya.
 */

export type ExpiryOutcome =
  /** Jalur ini yang memindahkan pemesanan ke EXPIRED. */
  | 'expired'
  /** Pemesanan sudah tidak HELD — dibayar, dibatalkan, atau jalur lain lebih dulu. */
  | 'already_moved'
  /** Belum waktunya menurut jam kita. Penyapu akan kembali. */
  | 'not_due'
  | 'unknown_booking'

export async function expireHold(deps: BookingDeps, bookingId: string): Promise<ExpiryOutcome> {
  const booking = await deps.bookings.findById(bookingId)

  if (booking === undefined) {
    // Kursi dipegang pemesanan yang tidak ada — pembuatan yang gagal setelah
    // hold lokal diambil. Kursinya dikembalikan lewat penyapu yatim, yang
    // membawa slotnya; di sini tidak ada slot untuk dilepaskan.
    return 'unknown_booking'
  }

  if (booking.status !== 'HELD') {
    await deps.holds.release({ bookingId, slot: slotOf(booking) })
    return 'already_moved'
  }

  const outcome = await moveToExpired(deps, booking)
  if (outcome !== 'not_due') await deps.holds.release({ bookingId, slot: slotOf(booking) })

  return outcome
}

async function moveToExpired(deps: BookingDeps, booking: Booking): Promise<ExpiryOutcome> {
  const saved = await persist(deps, booking, { type: 'expireHold', at: deps.clock.now() })

  // Satu-satunya aturan yang dapat menolak di sini adalah `hold_not_expired`:
  // Redis mengedaluwarsakan kunci menurut JAM REDIS, dan jam mesin ini boleh
  // sedikit tertinggal. Kedaluwarsa lebih awal adalah bug termahal di jalur
  // ini — pengguna yang sedang membayar kehilangan kamarnya — jadi keputusan
  // domain yang dipercaya, dan penyapu akan kembali.
  if (!saved.ok) return 'not_due'

  return saved.value.kind === 'saved' ? 'expired' : 'already_moved'
}
