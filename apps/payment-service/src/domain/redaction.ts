/**
 * Redaksi payload notifikasi sebelum dicatat.
 *
 * Tabel `webhook_events` menyimpan payload apa adanya supaya sengketa
 * pembayaran dapat ditelusuri berbulan-bulan kemudian. Payload notifikasi
 * Midtrans tidak memuat nomor kartu penuh, tetapi memuat `signature_key` — dan
 * signature_key yang tersimpan adalah setengah bahan untuk memalsukan
 * notifikasi. Basis data yang bocor tidak boleh sekaligus menjadi bocornya
 * kemampuan memalsukan pembayaran.
 *
 * Redaksi berdasarkan NAMA field, bukan berdasarkan isinya — pola yang sama
 * dengan supplier-service. Menebak dari isi, misalnya "string sepanjang 128
 * karakter heksadesimal", akan meredaksi pengenal transaksi yang justru paling
 * dibutuhkan saat menelusuri.
 */

const SENSITIVE_PATTERN =
  /(signature|secret|token|password|passwd|authorization|credential|api[-_]?key|server[-_]?key|client[-_]?key|card|cvv|pan|account[-_]?number)/i

export const REDACTED = '[redacted]'

/** Kedalaman maksimum penelusuran; melindungi dari struktur yang sangat dalam. */
const MAX_DEPTH = 8

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_PATTERN.test(key)
}

/**
 * Menyalin nilai dengan field sensitif diganti penanda.
 *
 * Mengembalikan salinan; masukan tidak pernah diubah. Meredaksi di tempat
 * berarti payload yang sama — yang tanda tangannya masih akan diverifikasi —
 * ikut kehilangan tanda tangannya.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return REDACTED
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1))
  if (typeof value !== 'object' || value === null) return value

  const result: Record<string, unknown> = {}

  for (const [key, entry] of Object.entries(value)) {
    result[key] = isSensitiveKey(key) ? REDACTED : redact(entry, depth + 1)
  }

  return result
}
