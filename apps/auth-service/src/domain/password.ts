/**
 * Aturan kekuatan kata sandi.
 *
 * Dua tipe berbeda untuk kata sandi mentah dan kata sandi ter-hash. Keduanya
 * string, tetapi menukarnya adalah kesalahan yang mahal — menyimpan kata sandi
 * mentah ke kolom hash, atau memverifikasi hash terhadap hash. Pembedaan di
 * tingkat tipe membuat penukaran itu tidak dapat dikompilasi.
 */

export type RawPassword = string & { readonly __brand: 'RawPassword' }
export type PasswordHash = string & { readonly __brand: 'PasswordHash' }

export const MIN_PASSWORD_LENGTH = 12

/**
 * Batas atas ada demi ketahanan, bukan keamanan. Argon2 sengaja lambat, dan
 * kata sandi sepanjang satu megabyte adalah cara murah membuat server sibuk.
 */
export const MAX_PASSWORD_LENGTH = 128

export type PasswordProblem = 'too_short' | 'too_long' | 'too_common'

/**
 * Daftar sangat pendek berisi kata sandi yang paling sering dipakai.
 *
 * Bukan pengganti pemeriksaan terhadap daftar bocoran yang sesungguhnya —
 * itu kebutuhan produksi yang membutuhkan layanan terpisah. Yang ini menangkap
 * kasus paling memalukan tanpa menambah ketergantungan apa pun.
 */
const COMMON_PASSWORDS = new Set([
  'password1234',
  'passwordpassword',
  '123456789012',
  'qwertyuiop12',
  'administrator',
  'letmeinplease',
])

export function validatePassword(raw: string): PasswordProblem | undefined {
  if (raw.length < MIN_PASSWORD_LENGTH) return 'too_short'
  if (raw.length > MAX_PASSWORD_LENGTH) return 'too_long'
  if (COMMON_PASSWORDS.has(raw.toLowerCase())) return 'too_common'

  return undefined
}

export function asRawPassword(value: string): RawPassword {
  return value as RawPassword
}

export function asPasswordHash(value: string): PasswordHash {
  return value as PasswordHash
}
