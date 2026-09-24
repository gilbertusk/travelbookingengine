import type { SupplierCode } from '../canonical/model.js'

/**
 * Kegagalan supplier sebagai union diskriminan, bukan satu kelas galat.
 *
 * Pembedaan ini terlihat berlebihan sekarang dan menjadi fondasi Step 11 dan
 * Step 19. Mencoba ulang `sold_out` adalah pemborosan murni — jawabannya tidak
 * akan berubah. Mencoba ulang `timeout` tanpa memeriksa status lebih dulu
 * adalah penyebab pemesanan ganda, karena batas waktu berarti permintaannya
 * mungkin sudah dikerjakan supplier.
 *
 * Dua varian di luar daftar awal Step 10 — `hold_expired` dan
 * `already_cancelled` — ditambahkan setelah melihat kegagalan yang benar-benar
 * dikirim mock-supplier. Menggabungkan keduanya ke `upstream_error` akan
 * menghapus perbedaan yang justru dibutuhkan saga pada Step 19: hold yang
 * kedaluwarsa aman diulang dari awal, sedangkan supplier yang rusak tidak.
 * Lihat catatan Step 10.
 */

export type SupplierErrorKind =
  /** Tidak menjawab dalam batas waktu. Permintaan MUNGKIN sudah dikerjakan. */
  | 'timeout'
  /** Tidak dapat dihubungi, atau menyatakan dirinya sedang tidak melayani. */
  | 'unavailable'
  | 'rate_limited'
  /** Menjawab, tetapi jawabannya tidak dapat dipercaya. */
  | 'invalid_response'
  | 'not_found'
  | 'sold_out'
  | 'price_changed'
  | 'hold_expired'
  | 'already_cancelled'
  /** Gagal dengan cara yang tidak masuk kategori mana pun di atas. */
  | 'upstream_error'

interface BaseError {
  readonly supplier: SupplierCode
  readonly operation: string
}

export type SupplierError = BaseError &
  (
    | { readonly kind: 'timeout'; readonly timeoutMs: number }
    | { readonly kind: 'unavailable'; readonly retryAfterSeconds?: number | undefined }
    | { readonly kind: 'rate_limited'; readonly retryAfterSeconds?: number | undefined }
    /** `reason` menjelaskan bagian mana yang cacat, untuk log — bukan untuk pengguna. */
    | { readonly kind: 'invalid_response'; readonly reason: string }
    | { readonly kind: 'not_found'; readonly what: string }
    | { readonly kind: 'sold_out' }
    | { readonly kind: 'price_changed' }
    | { readonly kind: 'hold_expired' }
    | { readonly kind: 'already_cancelled' }
    | {
        readonly kind: 'upstream_error'
        readonly status: number
        readonly code?: string | undefined
      }
  )

/**
 * Apakah mencoba ulang masuk akal sama sekali.
 *
 * Ini BUKAN kebijakan retry — kebijakan itu milik Step 11, lengkap dengan
 * jeda dan batas percobaan. Yang dijawab di sini hanya satu hal yang murni
 * tentang jenis kegagalannya: apakah jawabannya mungkin berbeda kalau
 * ditanyakan lagi.
 *
 * `timeout` termasuk dapat dicoba ulang, tetapi khusus untuk operasi yang
 * mengubah keadaan, pemanggil WAJIB memeriksa status lebih dulu lewat
 * idempotency key. Lihat [isSafeToBlindRetry].
 */
export function isRetryable(error: SupplierError): boolean {
  switch (error.kind) {
    case 'timeout':
    case 'unavailable':
    case 'rate_limited':
    case 'upstream_error':
      return true
    case 'invalid_response':
    case 'not_found':
    case 'sold_out':
    case 'price_changed':
    case 'hold_expired':
    case 'already_cancelled':
      return false
  }
}

/**
 * Apakah aman mengulang tanpa memeriksa apa pun lebih dulu.
 *
 * Hanya benar ketika kita yakin supplier tidak pernah menerima permintaannya.
 * Batas waktu tidak memberi keyakinan itu: supplier mungkin sudah membuat
 * pemesanan dan hanya responsnya yang tidak sampai.
 */
export function isSafeToBlindRetry(error: SupplierError): boolean {
  return error.kind === 'unavailable' || error.kind === 'rate_limited'
}

/** Keterangan singkat untuk log. Tidak pernah ditampilkan ke pengguna. */
export function describeSupplierError(error: SupplierError): string {
  return `${error.supplier}/${error.operation}: ${error.kind}`
}
