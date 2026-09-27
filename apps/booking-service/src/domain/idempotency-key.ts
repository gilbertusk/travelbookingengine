/**
 * Kunci idempotensi permintaan pemesanan (FR-18).
 *
 * Dikirim klien, jadi tidak tepercaya. Dua aturan di sini, keduanya berasal dari
 * kenyataan bahwa kunci ini menjadi bagian batasan UNIK di basis data:
 *
 * - **Panjang minimum 16.** Kunci pendek seperti `"1"` atau `"abc"` hampir pasti
 *   dipakai ulang oleh klien yang sama untuk pemesanan berbeda, dan pemesanan
 *   kedua akan dijawab dengan pemesanan pertama — pengguna mengira sudah
 *   memesan kamar yang lain.
 * - **Himpunan karakter terbatas.** Kunci masuk ke log dan ke kolom indeks.
 *   Spasi, baris baru, dan karakter kendali di sana hanya menyulitkan penelusuran
 *   tanpa menambah keunikan apa pun. UUID, ULID, dan base64url semuanya lolos.
 *
 * Keunikan TIDAK ditegakkan di sini. Keunikan adalah sifat kumpulan, bukan sifat
 * satu nilai; yang menegakkannya adalah batasan UNIK pada
 * `(user_id, idempotency_key)` — lihat prisma/schema.prisma.
 */

declare const idempotencyKeyBrand: unique symbol

export type IdempotencyKey = string & { readonly [idempotencyKeyBrand]: true }

export const IDEMPOTENCY_KEY_MIN_LENGTH = 16
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128

const ALLOWED = /^[A-Za-z0-9._:-]+$/

export function parseIdempotencyKey(value: string): IdempotencyKey | undefined {
  if (value.length < IDEMPOTENCY_KEY_MIN_LENGTH) return undefined
  if (value.length > IDEMPOTENCY_KEY_MAX_LENGTH) return undefined
  if (!ALLOWED.test(value)) return undefined

  // Merek hanya dilekatkan setelah ketiga aturan terbukti. Tidak ada jalan lain
  // untuk memperoleh IdempotencyKey, dan itu alasan satu-satunya assertion ini.
  return value as IdempotencyKey
}
