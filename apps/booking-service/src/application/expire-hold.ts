import type { BookingIn } from '../domain/booking.js'
import type { SagaState } from '../domain/saga-state.js'
import { applyCommand } from '../domain/transitions.js'
import { slotOf } from './hold-slot.js'
import type { BookingDeps } from './ports.js'
import { compensate } from './saga/compensation.js'

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

  return await moveToExpired(deps, booking)
}

/**
 * HELD → EXPIRED, dan kompensasi saga dimulai dalam transaksi yang SAMA:
 * langkah `awaitPayment` gagal, hold supplier dinyatakan habis sendiri, dan
 * pelepasan kursi lokal dicatat sebagai kompensasi langsung berikutnya lalu
 * dijalankan. Urutan Step 17 — basis data dulu, Redis sesudahnya — tetap:
 * kursi kembali ke slot hanya setelah pemesanannya tidak lagi HELD.
 */
async function moveToExpired(
  deps: BookingDeps,
  booking: BookingIn<'HELD'>,
): Promise<ExpiryOutcome> {
  const at = deps.clock.now()
  const change = applyCommand(booking, { type: 'expireHold', at })

  // Satu-satunya aturan yang dapat menolak di sini adalah `hold_not_expired`:
  // Redis mengedaluwarsakan kunci menurut JAM REDIS, dan jam mesin ini boleh
  // sedikit tertinggal. Kedaluwarsa lebih awal adalah bug termahal di jalur
  // ini — pengguna yang sedang membayar kehilangan kamarnya — jadi keputusan
  // domain yang dipercaya, dan penyapu akan kembali.
  if (!change.ok) return 'not_due'

  const outcome = await compensate(deps, {
    booking,
    saga: await sagaOf(deps, booking.id),
    change: change.value,
    start: {
      through: 'holdSupplier',
      stoppedAt: 'awaitPayment',
      at,
      reason: 'hold kedaluwarsa sebelum dibayar',
    },
  })
  if (outcome === 'committed') return 'expired'

  // Jalur lain lebih dulu: jalur keyspace dan penyapu bersamaan, atau
  // pembayaran yang tiba tepat di batas waktu. Pelepasan idempoten — kursi
  // kembali tepat sekali, oleh siapa pun yang benar-benar mengeluarkannya.
  await deps.holds.release({ bookingId: booking.id, slot: slotOf(booking) })
  return 'already_moved'
}

/**
 * Setiap pemesanan HELD punya saga: keduanya tersimpan dalam transaksi yang
 * sama di place-hold.ts. HELD tanpa saga berarti baris ditulis di luar jalur
 * itu — skrip perbaikan data, misalnya — dan itu cacat yang harus terlihat,
 * bukan hold yang diam-diam kedaluwarsa tanpa kompensasinya.
 */
async function sagaOf(deps: BookingDeps, bookingId: string): Promise<SagaState> {
  const saga = await deps.sagas.find(bookingId)
  if (saga === undefined) throw new Error(`pemesanan HELD ${bookingId} tidak punya saga`)

  return saga
}
