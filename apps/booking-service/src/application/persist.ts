import { err, ok, type Result } from '@tbe/shared-kernel'
import type { Booking } from '../domain/booking.js'
import type { BookingCommand } from '../domain/commands.js'
import type { BookingError } from '../domain/errors.js'
import { applyCommand } from '../domain/transitions.js'
import type { BookingDeps } from './ports.js'

/**
 * Menjalankan satu perintah domain dan menyimpan hasilnya.
 *
 * Hasil `stale` dari repository — pihak lain memindahkan pemesanan yang sama
 * lebih dulu — TIDAK diperlakukan sebagai galat. Yang dikembalikan adalah
 * keadaan yang MENANG, dibaca ulang dari basis data, dan pemanggil memutuskan
 * atas keadaan itu. Dua permintaan price check serentak dengan kunci
 * idempotensi yang sama berakhir dengan jawaban yang sama, bukan dengan satu
 * jawaban dan satu 409.
 */
export type Persisted =
  | { readonly kind: 'saved'; readonly booking: Booking }
  | { readonly kind: 'superseded'; readonly booking: Booking }

export async function persist(
  deps: BookingDeps,
  booking: Booking,
  command: BookingCommand,
): Promise<Result<Persisted, BookingError>> {
  const result = applyCommand(booking, command)
  if (!result.ok) return err(result.error)

  const outcome = await deps.bookings.save(result.value)
  if (outcome.kind === 'saved') return ok({ kind: 'saved', booking: result.value.booking })

  // Pemesanan yang hilang di antara dibaca dan disimpan hanya mungkin bila
  // barisnya dihapus, dan kunci asing booking_events → bookings (ON DELETE
  // RESTRICT) mencegah itu. Versi pertama menjadikannya varian hasil yang sah,
  // dan setiap pemanggil terpaksa menangani kemustahilan. Ini galat tak
  // terduga — CONVENTIONS.md bagian 5 — dan dilempar ke batas sistem.
  if (outcome.current === undefined) {
    throw new Error(`pemesanan ${booking.id} hilang di tengah transisi ${command.type}`)
  }

  return ok({ kind: 'superseded', booking: outcome.current })
}

/**
 * Pemesanan milik pengguna ini, atau `undefined`.
 *
 * Pemesanan milik orang lain dijawab SAMA dengan pemesanan yang tidak ada.
 * Membedakan keduanya — 403 untuk yang ada, 404 untuk yang tidak — memberi
 * tahu penebak pengenal bahwa tebakannya benar.
 */
export async function loadOwned(
  deps: BookingDeps,
  userId: string,
  bookingId: string,
): Promise<Booking | undefined> {
  const booking = await deps.bookings.findById(bookingId)

  return booking?.userId === userId ? booking : undefined
}
