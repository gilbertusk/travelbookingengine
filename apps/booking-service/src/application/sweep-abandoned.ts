import type { Booking, BookingIn } from '../domain/booking.js'
import type { BookingDeps } from './ports.js'
import { mustApply } from './saga/reaction.js'

/**
 * Penyapu pemesanan yang ditinggalkan sebelum hold (Step 28).
 *
 * Step 22 meninggalkan 990 DRAFT dan 61 PRICE_CHECKED dalam satu jalan uji
 * beban. Tidak satu pun memegang kamar atau uang, tetapi tidak satu pun final
 * — dan "seluruh pemesanan mencapai keadaan final" (NFR-06, M11) secara
 * harfiah tidak terpenuhi. Penyapu ini menutupnya: pemesanan yang tidak
 * disentuh lebih lama dari batasnya dibatalkan dengan alasan `abandoned`.
 *
 * Mengapa CANCELLED, bukan keadaan baru ABANDONED: keadaan final kelima
 * sudah cukup membedakan "tidak pernah memungut uang", dan alasannya sudah
 * membawa sebabnya. Keadaan baru berarti baris baru di tabel transisi, di
 * mesin keadaan panel, di pengelompokan daftar pengguna, dan di uji dua arah
 * FINAL_STATUSES — untuk informasi yang sudah ada di kolom alasan.
 *
 * Mengapa `updatedAt`, bukan `createdAt`: pengguna yang membuat pemesanan
 * kemarin lalu memeriksa harga lima menit lalu sedang aktif. Yang diukur
 * adalah berapa lama pemesanan tidak disentuh.
 *
 * Bersaing dengan pengguna yang kembali tepat saat penyapu berjalan aman:
 * keduanya lewat kunci versi. Bila pengguna menang, penyapu melihat
 * `superseded` dan melewatinya. Bila penyapu menang, permintaan pengguna
 * mendapat transisi tidak sah dari CANCELLED — jawaban yang benar untuk
 * pemesanan yang sudah ditinggalkan sehari.
 */

export interface AbandonPolicy {
  /** Berapa lama DRAFT atau PRICE_CHECKED tidak disentuh sebelum dianggap ditinggalkan. */
  readonly afterMs: number
  readonly batch: number
}

export interface AbandonReport {
  readonly abandoned: number
  /** Pemesanan yang bergerak di antara dibaca dan dibatalkan; pergerakannya yang menang. */
  readonly superseded: number
}

export async function sweepAbandoned(
  deps: BookingDeps,
  policy: AbandonPolicy,
): Promise<AbandonReport> {
  const now = deps.clock.now()
  const before = new Date(now.getTime() - policy.afterMs)
  const stale = await deps.bookings.findAbandoned(before, policy.batch)
  const report = { abandoned: 0, superseded: 0 }

  // Berurutan, seperti penyapu lain.
  for (const booking of stale.map(preHold)) {
    const change = mustApply(booking, { type: 'cancel', at: now, reason: 'abandoned' })
    const outcome = await deps.bookings.save(change)
    report[outcome.kind === 'saved' ? 'abandoned' : 'superseded'] += 1
  }

  return report
}

/**
 * Penjaga eksplisit, bukan penolakan domain. Tabel transisi MENGIZINKAN
 * `cancel` pada HELD — itulah jalan pembatalan karena pembayaran gagal, yang
 * melepas hold-nya lebih dulu. Penyapu yang menerima HELD dari kueri yang
 * salah akan membatalkannya tanpa melepas kamar di supplier maupun kursi di
 * Redis, dan domain tidak akan keberatan. Suntikan A4 di step doc menemukan
 * celah ini: versi pertama mengandalkan penolakan domain.
 */
function preHold(booking: Booking): BookingIn<'DRAFT' | 'PRICE_CHECKED'> {
  if (booking.status === 'DRAFT' || booking.status === 'PRICE_CHECKED') return booking

  throw new Error(`penyapu pemesanan yang ditinggalkan menerima ${booking.status} ${booking.id}`)
}
