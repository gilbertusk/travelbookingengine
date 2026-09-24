/**
 * Redaksi payload sebelum dicatat.
 *
 * Tabel `supplier_requests` ada untuk penelusuran dan rekonsiliasi, dan
 * karena itu ia menyimpan badan permintaan apa adanya. Badan permintaan ke
 * supplier memuat kunci API, dan kunci API yang tersimpan di basis data
 * berarti basis data yang bocor sekaligus menjadi bocornya akses ke seluruh
 * supplier.
 *
 * Redaksi dilakukan berdasarkan NAMA field, bukan berdasarkan isinya. Menebak
 * dari isi — misalnya "string sepanjang 32 karakter heksadesimal" — akan
 * meredaksi pengenal pemesanan yang justru paling dibutuhkan saat menelusuri.
 */

const SENSITIVE_PATTERN =
  /(api[-_]?key|secret|password|passwd|token|authorization|credential|signature|card|cvv|pan)/i

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
 * berarti payload yang sama — yang mungkin masih akan dikirim ke supplier —
 * ikut kehilangan kredensialnya.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return REDACTED
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1))
  if (typeof value !== 'object' || value === null) return value

  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    result[key] = isSensitiveKey(key) ? REDACTED : redact(entry, depth + 1)
  }

  return result
}

/**
 * Badan permintaan yang berupa string JSON.
 *
 * Adapter menyusun badan permintaan sebagai string sebelum mengirimnya, jadi
 * yang sampai ke pencatatan adalah teks. Teks yang bukan JSON dikembalikan
 * apa adanya hanya bila jelas tidak memuat apa pun yang sensitif — selain itu
 * ia diredaksi seluruhnya, karena yang tidak dapat diperiksa tidak dapat
 * dijamin aman.
 */
export function redactBody(body: string | undefined): unknown {
  if (body === undefined || body.length === 0) return null

  try {
    return redact(JSON.parse(body))
  } catch {
    return SENSITIVE_PATTERN.test(body) ? REDACTED : body
  }
}

/**
 * Header yang ikut tercatat.
 *
 * Daftar putih, bukan daftar hitam. Header baru yang ditambahkan supplier
 * atau proksi tidak boleh otomatis ikut tercatat hanya karena namanya belum
 * ada di daftar yang dilarang.
 */
const LOGGABLE_HEADERS = new Set(['content-type', 'accept', 'retry-after', 'idempotency-key'])

export function redactHeaders(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): Record<string, string> {
  const result: Record<string, string> = {}

  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase()
    if (!LOGGABLE_HEADERS.has(key) || value === undefined) continue

    result[key] = Array.isArray(value) ? value.join(', ') : value
  }

  return result
}
