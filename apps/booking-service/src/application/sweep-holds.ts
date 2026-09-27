import { expireHold, type ExpiryOutcome } from './expire-hold.js'
import type { BookingDeps, HoldEntry } from './ports.js'

/**
 * Penyapu hold berkala — jaring pengaman untuk keyspace notification.
 *
 * Redis TIDAK menjamin notifikasi sampai: pelanggan yang sedang terputus saat
 * sebuah kunci kedaluwarsa tidak akan pernah menerimanya, dan tidak ada antrian
 * yang menyimpannya. Tanpa penyapu, hold yatim menahan inventaris selamanya.
 *
 * Dua sumber, karena ada dua cara hold menjadi yatim:
 *
 * 1. **Basis data**: pemesanan HELD yang `held_until`-nya lewat. Menangkap
 *    notifikasi yang hilang.
 * 2. **Redis**: kursi di slot yang kunci waktunya sudah hilang. Menangkap
 *    proses yang mati di antara mengambil hold lokal dan menyimpan pemesanan —
 *    kursi yang tidak dikenal basis data sama sekali, sehingga sumber pertama
 *    tidak akan pernah melihatnya.
 *
 * Idempoten dan aman berjalan bersamaan dengan jalur keyspace: seluruh
 * perpindahan lewat [expireHold], yang dijaga kunci versi dan pelepasan
 * idempoten.
 */

export interface SweepReport {
  readonly due: Readonly<Record<ExpiryOutcome, number>>
  readonly orphansReleased: number
}

export async function sweepHolds(deps: BookingDeps): Promise<SweepReport> {
  const due = await deps.bookings.findExpiredHolds(deps.clock.now(), deps.holdPolicy.sweepBatch)
  const counts: Record<ExpiryOutcome, number> = {
    expired: 0,
    already_moved: 0,
    not_due: 0,
    unknown_booking: 0,
  }

  // Berurutan, bukan serentak: penyapu adalah jaring pengaman, bukan jalur
  // utama, dan seratus transaksi serentak dari satu putaran penyapu hanya
  // bersaing dengan permintaan pengguna untuk koneksi basis data.
  for (const booking of due) {
    const outcome = await expireHold(deps, booking.id)
    counts[outcome] += 1
  }

  const orphans = await deps.holds.orphans(deps.holdPolicy.sweepBatch)
  let orphansReleased = 0
  for (const orphan of orphans) {
    if (await releaseOrphan(deps, orphan)) orphansReleased += 1
  }

  return { due: counts, orphansReleased }
}

/**
 * Kursi yang kunci waktunya sudah hilang.
 *
 * Kursi milik pemesanan yang MASIH HELD tidak disentuh di sini: kunci waktunya
 * hilang lebih awal dari `held_until` — Redis dimulai ulang tanpa persistensi,
 * misalnya — tetapi pemesanannya sah sampai batas waktunya, dan sumber pertama
 * penyapu yang akan mengedaluwarsakannya tepat waktu.
 */
async function releaseOrphan(deps: BookingDeps, orphan: HoldEntry): Promise<boolean> {
  const booking = await deps.bookings.findById(orphan.bookingId)
  if (booking?.status === 'HELD') return false

  return await deps.holds.release(orphan)
}
