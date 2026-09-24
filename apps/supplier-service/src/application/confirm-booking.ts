import type { BookingResult, SupplierCode, SupplierError } from '@tbe/supplier-adapters'
import { callSupplier } from './call-supplier.js'
import type { ResilienceDeps } from './ports.js'

/**
 * Mengubah hold menjadi pemesanan, dengan pemulihan yang aman.
 *
 * Ini implementasi US-05, dan satu-satunya bagian project ini yang secara
 * langsung mencegah kerugian uang sungguhan.
 *
 * Persoalannya: ketika `book` kehabisan waktu, kita **tidak tahu** apakah
 * pemesanan terbentuk. Supplier mungkin sudah membuatnya dan hanya responsnya
 * yang tidak sampai. Mengulang `book` dalam keadaan itu menghasilkan pemesanan
 * kedua — dan pemesanan kedua berarti kamar kedua yang dibayar, tagihan yang
 * harus dikembalikan, dan pengguna yang menerima dua surel konfirmasi.
 *
 * Jalan yang benar: JANGAN mengulang `book`. Tanyakan lebih dulu dengan
 * idempotency key yang sama.
 *
 *   book → timeout
 *        → findBookingByIdempotencyKey(kunci)
 *            → ketemu     → adopsi, selesai. Tidak ada pemesanan kedua.
 *            → not_found  → supplier memang belum menerimanya. Baru sekarang
 *                           `book` boleh diulang.
 *            → gagal lagi → keadaan TIDAK DAPAT DIPASTIKAN. Dilaporkan apa
 *                           adanya, bukan ditebak.
 *
 * Kunci yang sama dipakai pada setiap percobaan. Kunci yang berubah membuat
 * seluruh mekanisme ini tidak berarti apa-apa.
 */

export interface ConfirmParams {
  readonly supplier: SupplierCode
  readonly holdRef: string
  readonly guestName: string
  /** WAJIB sama pada setiap percobaan untuk pemesanan yang sama. */
  readonly idempotencyKey: string
  readonly correlationId?: string | undefined
}

export type ConfirmOutcome =
  | { readonly status: 'confirmed'; readonly booking: BookingResult; readonly adopted: boolean }
  | { readonly status: 'failed'; readonly error: SupplierError }
  /**
   * Keadaan di supplier tidak dapat dipastikan.
   *
   * Bukan kegagalan, dan bukan keberhasilan. Saga pada Step 19 menandai
   * pemesanan sebagai perlu ditinjau dan rekonsiliasi pada Step 28 yang
   * menuntaskannya. Menebak salah satu di sini adalah cara membuat kerugian
   * diam-diam: menebak "gagal" meninggalkan pemesanan hantu yang tetap
   * ditagih, menebak "berhasil" menjanjikan kamar yang mungkin tidak ada.
   */
  | { readonly status: 'uncertain'; readonly error: SupplierError; readonly idempotencyKey: string }

/**
 * Berapa kali `book` boleh benar-benar dikirim ulang.
 *
 * Dihitung terpisah dari percobaan ulang biasa, dan sengaja kecil: setiap
 * pengiriman ulang hanya terjadi setelah kita YAKIN supplier belum menerima
 * yang sebelumnya.
 */
const MAX_BOOK_ATTEMPTS = 3

export async function confirmBooking(
  deps: ResilienceDeps,
  params: ConfirmParams,
): Promise<ConfirmOutcome> {
  const gateway = deps.registry.get(params.supplier)

  for (let attempt = 1; attempt <= MAX_BOOK_ATTEMPTS; attempt += 1) {
    const booked = await callSupplier(deps, {
      supplier: params.supplier,
      operation: 'book',
      // Percobaan ulang otomatis DIMATIKAN. Keputusan mengulang operasi ini
      // tidak boleh diambil kebijakan umum — ia diambil di sini, setelah
      // status sebenarnya diketahui.
      noRetry: true,
      idempotencyKey: params.idempotencyKey,
      correlationId: params.correlationId,
      requestPayload: { holdRef: params.holdRef, guestName: params.guestName },
      run: async () =>
        await gateway.book(params.holdRef, { fullName: params.guestName }, params.idempotencyKey),
    })

    if (booked.ok) return { status: 'confirmed', booking: booked.value, adopted: false }

    const next = await resolve(deps, params, booked.error)
    if (next.status !== 'retry_book') return next
  }

  return {
    status: 'uncertain',
    error: {
      supplier: params.supplier,
      operation: 'book',
      kind: 'upstream_error',
      status: 0,
      code: 'MAX_BOOK_ATTEMPTS',
    },
    idempotencyKey: params.idempotencyKey,
  }
}

type Resolution = ConfirmOutcome | { readonly status: 'retry_book' }

/**
 * Menentukan apa yang harus dilakukan setelah `book` gagal.
 *
 * Tiga jalur, dan pemisahannya seluruhnya bergantung pada jenis kegagalan
 * yang dibedakan Step 10.
 */
async function resolve(
  deps: ResilienceDeps,
  params: ConfirmParams,
  error: SupplierError,
): Promise<Resolution> {
  // 1. Supplier PASTI belum menerima permintaannya: pemutus terbuka, koneksi
  //    ditolak, atau kuota habis. Tidak ada pemesanan yang mungkin terbentuk,
  //    jadi mengirim ulang aman tanpa bertanya apa pun.
  if (error.kind === 'unavailable' || error.kind === 'rate_limited') {
    return { status: 'retry_book' }
  }

  // 2. Jawaban yang sah dari supplier yang sehat. Mengulangnya tidak akan
  //    mengubah apa pun.
  if (!isUncertain(error)) return { status: 'failed', error }

  // 3. Keadaan tidak diketahui. Inilah satu-satunya jalan keluarnya.
  return await askSupplier(deps, params, error)
}

/**
 * Kegagalan yang meninggalkan keadaan supplier tidak diketahui.
 *
 * `timeout` jelas. `upstream_error` juga: 500 dapat berarti supplier gagal
 * SETELAH menyimpan pemesanan. `invalid_response` pun demikian — respons yang
 * tidak dapat diurai bisa saja merupakan konfirmasi yang bentuknya berubah.
 */
function isUncertain(error: SupplierError): boolean {
  return (
    error.kind === 'timeout' || error.kind === 'upstream_error' || error.kind === 'invalid_response'
  )
}

async function askSupplier(
  deps: ResilienceDeps,
  params: ConfirmParams,
  original: SupplierError,
): Promise<Resolution> {
  const gateway = deps.registry.get(params.supplier)

  const found = await callSupplier(deps, {
    supplier: params.supplier,
    operation: 'getBooking',
    idempotencyKey: params.idempotencyKey,
    correlationId: params.correlationId,
    requestPayload: { idempotencyKey: params.idempotencyKey },
    run: async () => await gateway.findBookingByIdempotencyKey(params.idempotencyKey),
  })

  if (found.ok) {
    // Pemesanan sudah ada. Diadopsi apa adanya — inilah yang mencegah
    // pemesanan kedua.
    return { status: 'confirmed', booking: found.value, adopted: true }
  }

  if (found.error.kind === 'not_found') {
    // Supplier memang belum pernah menerimanya. Baru sekarang aman mengulang.
    return { status: 'retry_book' }
  }

  // Bertanya pun gagal. Keadaannya tetap tidak diketahui, dan itulah yang
  // dilaporkan — kegagalan yang ASLI, bukan kegagalan saat bertanya, karena
  // yang pertama itulah yang menjelaskan kenapa statusnya tidak pasti.
  return { status: 'uncertain', error: original, idempotencyKey: params.idempotencyKey }
}
