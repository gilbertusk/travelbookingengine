import type { Result } from '@tbe/shared-kernel'
import type {
  BookingResult,
  HoldResult,
  PriceCheckResult,
  SupplierCode,
  SupplierSearchResult,
} from '../canonical/model.js'
import type { SupplierError } from '../errors/supplier-error.js'

/**
 * Satu antarmuka yang harus dipenuhi kelima supplier.
 *
 * Inilah seluruh alasan paket ini ada: di balik antarmuka ini, SOAP dengan
 * tanggal DD/MM/YYYY dan JSON dengan epoch detik menjadi hal yang sama.
 * Pemanggil — search-service, booking-service — tidak boleh tahu supplier mana
 * yang berbicara XML.
 *
 * Kegagalan dikembalikan sebagai nilai lewat Result, tidak dilempar.
 * CONVENTIONS.md bagian 5: supplier yang kehabisan kamar bukan kejadian luar
 * biasa, itu jawaban — dan tipe inilah yang memaksa pemanggil menanganinya.
 *
 * Paket ini murni penerjemahan. Tidak ada pemutus sirkuit, tidak ada percobaan
 * ulang, tidak ada cache; ketiganya milik Step 11 dan diletakkan DI ATAS
 * antarmuka ini, bukan di dalamnya.
 */

export interface SearchCriteria {
  readonly city: string
  /** Tanggal kalender `YYYY-MM-DD`, bukan titik waktu. */
  readonly checkIn: string
  readonly checkOut: string
  readonly guests: number
}

export interface GuestDetails {
  readonly fullName: string
}

export interface SupplierGateway {
  readonly supplier: SupplierCode

  search(criteria: SearchCriteria): Promise<Result<SupplierSearchResult, SupplierError>>

  /**
   * Verifikasi harga langsung ke supplier. Tidak boleh dilayani dari cache —
   * lihat glosarium PRD Bab 8.
   */
  priceCheck(
    supplierRatePlanId: string,
    stay: { readonly checkIn: string; readonly checkOut: string },
  ): Promise<Result<PriceCheckResult, SupplierError>>

  hold(
    supplierRatePlanId: string,
    stay: { readonly checkIn: string; readonly checkOut: string },
    guests: number,
  ): Promise<Result<HoldResult, SupplierError>>

  /**
   * Mengubah hold menjadi pemesanan.
   *
   * `idempotencyKey` wajib dan harus tetap sama pada setiap percobaan ulang
   * untuk permintaan yang sama. Tanpa itu, satu batas waktu berubah menjadi
   * dua pemesanan dan kerugian uang sungguhan.
   */
  book(
    supplierHoldId: string,
    guest: GuestDetails,
    idempotencyKey: string,
  ): Promise<Result<BookingResult, SupplierError>>

  cancel(bookingReference: string): Promise<Result<void, SupplierError>>

  getBooking(bookingReference: string): Promise<Result<BookingResult, SupplierError>>

  /**
   * Mencari pemesanan berdasarkan idempotency key.
   *
   * Inilah satu-satunya jalan keluar dari ketidakpastian setelah `book`
   * kehabisan waktu: sistem tidak tahu apakah pemesanan terbentuk, dan
   * bertanya dengan kuncinya adalah satu-satunya cara aman mencari tahu.
   * Dipakai saga pada Step 19.
   */
  findBookingByIdempotencyKey(idempotencyKey: string): Promise<Result<BookingResult, SupplierError>>
}
