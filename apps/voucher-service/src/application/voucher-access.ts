import type { VoucherDeps } from './ports.js'

/**
 * Akses unduhan voucher (Step 23, butir 4).
 *
 * Dua lapis penjaga, dan keduanya wajib:
 *
 * 1. **Kepemilikan diperiksa di sini**, terhadap pemilik yang tercatat saat
 *    voucher terbit. URL bertanda tangan saja tidak cukup: URL bocor lewat
 *    riwayat peramban, log proxy, dan tautan yang dibagikan tanpa sengaja.
 * 2. **URL berumur pendek.** URL yang bocor berhenti berlaku dalam hitungan
 *    menit, dan pemiliknya selalu dapat meminta yang baru.
 *
 * Voucher milik orang lain dijawab "tidak ditemukan", bukan "dilarang". 403
 * mengonfirmasi bahwa pemesanan itu ada, dan itu sudah informasi.
 */

/** Umur URL unduhan. Cukup untuk satu klik dan satu unduhan yang lambat. */
export const SIGNED_URL_TTL_SECONDS = 5 * 60

export type AccessResult =
  | { readonly kind: 'link'; readonly url: string; readonly expiresAt: Date }
  | { readonly kind: 'not_found' }
  /** Pemesanan ada dan milik pengguna, tetapi belum CONFIRMED. */
  | { readonly kind: 'not_confirmed'; readonly status: string }
  /** Sudah CONFIRMED; voucher sedang diterbitkan. */
  | { readonly kind: 'pending' }

export async function voucherLink(
  deps: VoucherDeps,
  request: { readonly userId: string; readonly bookingId: string },
): Promise<AccessResult> {
  const voucher = await deps.vouchers.findByBookingId(request.bookingId)

  if (voucher !== undefined) {
    if (voucher.userId !== request.userId) return { kind: 'not_found' }

    const url = await deps.storage.signedUrl(voucher.objectKey, SIGNED_URL_TTL_SECONDS)
    const expiresAt = new Date(deps.clock.now().getTime() + SIGNED_URL_TTL_SECONDS * 1_000)
    return { kind: 'link', url, expiresAt }
  }

  // Belum ada voucher: tanyakan pemesanannya, supaya jawabannya jelas — belum
  // terkonfirmasi, atau sedang diterbitkan — alih-alih 404 untuk keduanya.
  const lookup = await deps.bookings.voucherSource(request.bookingId)
  if (lookup.kind === 'not_found' || lookup.source.userId !== request.userId) {
    return { kind: 'not_found' }
  }

  if (lookup.source.status !== 'CONFIRMED') {
    return { kind: 'not_confirmed', status: lookup.source.status }
  }

  return { kind: 'pending' }
}

/**
 * Isi berkas voucher untuk service lain (Step 24): notification-service
 * melampirkannya pada surel konfirmasi.
 *
 * Tidak ada pemeriksaan kepemilikan di sini. Pemanggilnya service di jaringan
 * internal yang mengirim surel ke tamu pemesanan itu sendiri; kunci objek
 * tetap tidak pernah keluar dari service ini.
 */
export async function voucherDocument(
  deps: VoucherDeps,
  bookingId: string,
): Promise<Uint8Array | undefined> {
  const voucher = await deps.vouchers.findByBookingId(bookingId)
  if (voucher === undefined) return undefined

  return await deps.storage.read(voucher.objectKey)
}
