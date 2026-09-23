import { err, ok, type Result } from '@tbe/shared-kernel'

/**
 * Alamat surel sebagai value object.
 *
 * Normalisasi terjadi di satu tempat dan hanya di sini. Tanpa itu,
 * "Budi@Example.com " dan "budi@example.com" menjadi dua akun berbeda, dan
 * batasan unik di database tidak mencegahnya karena keduanya memang string
 * yang berbeda.
 */

export type Email = string & { readonly __brand: 'Email' }

export type EmailProblem = 'empty' | 'invalid_format' | 'too_long'

/** Batas praktis; RFC mengizinkan lebih panjang, tetapi tidak ada yang memakainya. */
const MAX_EMAIL_LENGTH = 254

// Sengaja tidak memakai pola RFC 5322 lengkap. Pola itu menerima bentuk yang
// tidak satu pun penyedia surel sungguhan terima, dan menolak sebagian yang
// mereka terima. Validasi sebenarnya adalah surel verifikasi yang terkirim.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase()
}

export function createEmail(raw: string): Result<Email, EmailProblem> {
  const normalized = normalizeEmail(raw)

  if (normalized.length === 0) return err('empty')
  if (normalized.length > MAX_EMAIL_LENGTH) return err('too_long')
  if (!EMAIL_PATTERN.test(normalized)) return err('invalid_format')

  return ok(normalized as Email)
}
