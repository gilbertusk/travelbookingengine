import type { Booking, DraftBooking } from '../domain/booking.js'
import type { BookingChange } from '../domain/events.js'
import type { IdempotencyKey } from '../domain/idempotency-key.js'

/**
 * Port yang dipenuhi infrastructure.
 *
 * Hanya satu di Step 16, dan bentuknya yang membawa seluruh keputusannya:
 * **tidak ada operasi yang menyimpan pemesanan tanpa peristiwanya, dan tidak
 * ada operasi yang menulis peristiwa tanpa pemesanannya.** Keduanya masuk
 * sebagai satu [BookingChange]. Implementasi yang menulis keduanya di dua
 * transaksi terpisah masih dapat ditulis — port tidak dapat mencegahnya — tetapi
 * tidak ada pemanggil yang dapat meminta salah satunya saja.
 *
 * Tidak ada `update` dan `delete` untuk peristiwa. booking_events hanya
 * bertambah (NFR-10).
 */

/**
 * Hasil pembuatan, dijaga batasan UNIK `(user_id, idempotency_key)`.
 *
 * `duplicate` membawa pemesanan yang sudah ada, sehingga pemanggil
 * mengembalikannya tanpa kueri kedua — kueri kedua itulah pola "periksa dulu
 * baru tulis" yang punya celah balapan (FR-18, Step 17).
 */
export type CreateOutcome =
  { readonly kind: 'created' } | { readonly kind: 'duplicate'; readonly existing: Booking }

/**
 * Hasil penyimpanan transisi, dijaga kunci versi.
 *
 * `stale` berarti pemesanan sudah dipindahkan pihak lain sejak dibaca — jalur
 * keyspace dan penyapu yang sama-sama mengedaluwarsakan hold, atau pembayaran
 * yang tiba bersamaan dengan kedaluwarsa. Tidak ada yang ditulis, dan
 * `current` adalah keadaan yang menang, supaya pemanggil dapat memutuskan
 * ulang atas keadaan yang sebenarnya.
 */
export type SaveOutcome =
  { readonly kind: 'saved' } | { readonly kind: 'stale'; readonly current: Booking | undefined }

export interface BookingRepository {
  findById(id: string): Promise<Booking | undefined>

  /**
   * Pencarian dengan kunci idempotensi SELALU bersama pemiliknya. Kunci dikirim
   * klien; dua pengguna dapat mengirim kunci yang sama, dan mencari tanpa
   * `userId` berarti mengembalikan pemesanan orang lain.
   */
  findByIdempotencyKey(userId: string, key: IdempotencyKey): Promise<Booking | undefined>

  /** Menyisipkan pemesanan baru beserta peristiwa pembuatannya, satu transaksi. */
  create(change: BookingChange<DraftBooking>): Promise<CreateOutcome>

  /**
   * Menyimpan hasil transisi beserta peristiwanya, satu transaksi — hanya bila
   * versi yang tersimpan masih versi sebelum transisi ini.
   */
  save(change: BookingChange): Promise<SaveOutcome>
}
