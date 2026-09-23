import argon2 from 'argon2'
import { asPasswordHash, type PasswordHash, type RawPassword } from '../domain/password.js'
import type { PasswordHasher } from '../application/ports.js'

/**
 * Argon2id, bukan bcrypt.
 *
 * bcrypt masih dianggap memadai, tetapi memotong kata sandi pada 72 byte dan
 * tidak tahan terhadap serangan berbasis memori. Argon2id menahan keduanya dan
 * merupakan rekomendasi OWASP sejak lama.
 *
 * Parameter di bawah mengikuti profil OWASP: 19 MiB memori, dua iterasi,
 * paralelisme satu. Menurunkannya "supaya lebih cepat" adalah cara paling
 * mudah membatalkan seluruh manfaatnya.
 */

export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const

export function createArgon2Hasher(): PasswordHasher {
  return {
    async hash(raw: RawPassword) {
      return asPasswordHash(await argon2.hash(raw, ARGON2_OPTIONS))
    },

    async verify(hash: PasswordHash, raw: RawPassword) {
      try {
        return await argon2.verify(hash, raw)
      } catch {
        // Hash yang bentuknya rusak berarti verifikasi gagal, bukan sistem
        // yang bermasalah. Melemparnya di sini akan membuat endpoint masuk
        // menjawab 500 dan sekaligus membocorkan bahwa akunnya memang ada.
        return false
      }
    },
  }
}
