import { ApiError } from '@/lib/api-error'
import type { Booking, Money } from './types'

/**
 * Keputusan alur pemesanan, sebagai fungsi murni.
 *
 * Komponen hanya menjalankan efek — memanggil jaringan, membuka popup — lalu
 * menyerahkan HASILNYA ke sini untuk menentukan layar berikutnya. Seluruh
 * cabang yang menentukan apakah pengguna melihat dialog harga, hitung mundur,
 * atau jalan buntu dapat diuji tanpa merender apa pun.
 */

export type FlowStep =
  /** Mengisi data tamu. */
  | { readonly step: 'details' }
  | { readonly step: 'working'; readonly label: string }
  | {
      readonly step: 'rate_changed'
      readonly booking: Booking
      readonly previous: Money
      readonly current: Money
      readonly difference: Money | null
    }
  /** Kamar tertahan; hitung mundur berjalan dan pembayaran dapat dibuka. */
  | { readonly step: 'held'; readonly booking: Booking }
  /** Pembayaran sudah melewati halaman ini — statusnya di halaman lain. */
  | { readonly step: 'paid'; readonly booking: Booking }
  | { readonly step: 'expired' }
  | { readonly step: 'unavailable'; readonly reason: 'sold_out' | 'rate_gone' }
  | { readonly step: 'failed'; readonly retry: RetryAction; readonly message: string }

/** Yang diulang tombol "Coba lagi". Setiap galat punya jalan keluarnya sendiri. */
export type RetryAction = 'check' | 'hold' | 'pay'

/**
 * Langkah berikutnya menurut KEADAAN pemesanan — dipakai setelah price check,
 * setelah persetujuan harga, dan saat halaman dimuat ulang di tengah alur.
 * Keadaan, bukan jalannya permintaan, yang menentukan: dua tab yang
 * memesan hal yang sama berakhir di layar yang sama.
 */
export type Decision =
  /** Harga terverifikasi: tahan kamarnya. */
  | { readonly step: 'do_hold' }
  /** Harga belum terverifikasi: price check lagi dengan kunci yang sama. */
  | { readonly step: 'do_recheck' }
  | FlowStep

export function decide(booking: Booking): Decision {
  switch (booking.status) {
    case 'HELD':
      return { step: 'held', booking }
    case 'PAID':
    case 'CONFIRMED':
    case 'FAILED':
    case 'REFUNDED':
    case 'NEEDS_REVIEW':
      return { step: 'paid', booking }
    case 'EXPIRED':
      return { step: 'expired' }
    case 'CANCELLED':
      return { step: 'unavailable', reason: 'rate_gone' }
    case 'DRAFT':
      return { step: 'do_recheck' }
    case 'PRICE_CHECKED':
      return decidePriceChecked(booking)
  }
}

function decidePriceChecked(booking: Booking): Decision {
  const check = booking.priceCheck
  if (check === null) return { step: 'do_recheck' }

  switch (check.outcome) {
    case 'unchanged':
      return { step: 'do_hold' }
    case 'changed':
      return {
        step: 'rate_changed',
        booking,
        previous: check.previous,
        current: check.current,
        difference: check.difference,
      }
    // Harga baru disetujui tetapi belum terverifikasi ulang — supplier belum
    // menjawab. Price check dengan kunci yang sama memverifikasinya.
    case 'awaiting_recheck':
      return { step: 'do_recheck' }
    case 'unavailable':
      return { step: 'unavailable', reason: 'rate_gone' }
  }
}

/**
 * Galat jaringan menjadi layar. Kode yang dikenali punya jalan keluarnya
 * sendiri; sisanya layar "coba lagi" untuk aksi yang sama.
 *
 * `undefined` berarti galat ini bukan untuk ditampilkan, melainkan untuk
 * ditindaklanjuti pemanggil: harga berubah saat hold (price check lagi), atau
 * hold yang sedang diproses permintaan lain (baca keadaannya).
 */
export function stepForError(error: unknown, action: RetryAction): FlowStep | undefined {
  const code = error instanceof ApiError ? error.code : undefined

  switch (code) {
    case 'SOLD_OUT':
      return { step: 'unavailable', reason: 'sold_out' }
    case 'RATE_UNAVAILABLE':
      return { step: 'unavailable', reason: 'rate_gone' }
    case 'HOLD_EXPIRED':
      return { step: 'expired' }
    case 'PRICE_CHANGED':
    case 'HOLD_IN_PROGRESS':
    case 'ALREADY_PAID':
    case 'NOT_PAYABLE':
      return undefined
    case 'PAYMENT_REJECTED':
      return {
        step: 'failed',
        retry: 'pay',
        message:
          'Penyedia pembayaran menolak membuka transaksi ini. Kamarmu masih tertahan — coba lagi, atau pilih metode lain di halaman bayar.',
      }
    default:
      return { step: 'failed', retry: action, message: messageFor(error, action) }
  }
}

function messageFor(error: unknown, action: RetryAction): string {
  if (error instanceof ApiError && error.kind === 'network') {
    return 'Koneksi terputus. Belum ada yang ditagih — periksa koneksimu, lalu coba lagi.'
  }
  if (error instanceof ApiError && error.kind === 'unauthorized') {
    return 'Sesimu sudah berakhir. Masuk kembali untuk melanjutkan pemesanan.'
  }

  switch (action) {
    case 'check':
      return 'Harga belum dapat diperiksa ke penyedia saat ini. Belum ada yang ditagih — coba lagi sebentar.'
    case 'hold':
      return 'Kamar belum dapat ditahan karena penyedia belum menjawab. Belum ada yang ditagih — coba lagi.'
    case 'pay':
      return 'Halaman pembayaran belum dapat dibuka. Kamarmu masih tertahan dan belum ada yang ditagih.'
  }
}

/** Kunci sessionStorage untuk idempotency key satu pilihan kamar. */
export function idempotencyStorageKey(selectionKey: string): string {
  return `tbe:booking-key:${selectionKey}`
}
