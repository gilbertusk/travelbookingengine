import type { GuestDetails } from './guest-details.js'
import type { IdempotencyKey } from './idempotency-key.js'
import type { OfferTerms } from './offer-terms.js'
import type { PriceBreakdown } from './price.js'
import type { StayDates } from './stay-dates.js'

/**
 * Pemesanan sebagai union diskriminan sepuluh keadaan.
 *
 * CONVENTIONS.md bagian 3. Yang dibeli dengan bentuk ini bukan kerapian: keadaan
 * CONFIRMED WAJIB membawa booking reference supplier, dan keadaan DRAFT TIDAK
 * BOLEH membawanya. Dengan satu objek berbidang nullable, `booking.supplierRef`
 * dapat dibaca di mana saja, lulus kompilasi, lalu mengirim `undefined` ke
 * e-voucher sebagai bukti pemesanan (FR-24).
 *
 * Union biasa belum cukup. TypeScript hanya memeriksa bidang berlebih pada
 * literal objek; objek yang sudah bertipe — hasil spread dari keadaan lain —
 * lolos dengan bidang yang bukan miliknya. Karena itu setiap keadaan juga
 * menyatakan bidang milik keadaan LAIN sebagai `?: never` (lihat [Forbid]).
 * Hasilnya, `{ ...confirmed, status: 'DRAFT' }` ditolak compiler karena
 * `supplierRef: string` tidak dapat masuk ke `never` — dibuktikan di
 * booking.types.test.ts, yang gagal typecheck bila penjagaan ini dilepas.
 */

export const BOOKING_STATUSES = [
  'DRAFT',
  'PRICE_CHECKED',
  'HELD',
  'PAID',
  'CONFIRMED',
  'FAILED',
  'REFUNDED',
  'CANCELLED',
  'EXPIRED',
  'NEEDS_REVIEW',
] as const

export type BookingStatus = (typeof BOOKING_STATUSES)[number]

/**
 * Keadaan final: tidak punya satu pun transisi keluar.
 *
 * Lima, sesuai step doc — dan sesuai NFR-06, yang menyebut tiga akhir yang sah:
 * terkonfirmasi, dibatalkan dengan dana kembali, atau ditandai untuk peninjauan
 * manual. CANCELLED dan EXPIRED adalah "dibatalkan" yang tidak pernah memungut
 * uang; REFUNDED adalah "dibatalkan" yang sudah memungut dan mengembalikannya.
 *
 * Daftar ini TIDAK dipercaya begitu saja. transitions.test.ts memeriksanya
 * terhadap tabel transisi dari dua arah: setiap keadaan di sini tidak punya
 * transisi keluar, DAN setiap keadaan tanpa transisi keluar ada di sini.
 */
export const FINAL_STATUSES = [
  'CONFIRMED',
  'REFUNDED',
  'CANCELLED',
  'EXPIRED',
  'NEEDS_REVIEW',
] as const satisfies readonly BookingStatus[]

export type FinalStatus = (typeof FINAL_STATUSES)[number]

export function isFinal(status: BookingStatus): status is FinalStatus {
  return FINAL_STATUSES.some((final) => final === status)
}

/**
 * Kode supplier. Disalin, bukan diimpor dari @tbe/supplier-adapters: domain
 * tidak boleh menarik pustaka HTTP dan pengurai XML hanya demi lima string.
 * Kesepakatannya dengan kontrak peristiwa diperiksa uji di
 * application/contract-payloads.test.ts — kode yang ada di sini tetapi tidak di
 * kontrak akan menggagalkan penguraian payload.
 */
export const SUPPLIER_CODES = ['SKY', 'NOVA', 'ORBIT', 'LUNA', 'ZEPH'] as const
export type SupplierCode = (typeof SUPPLIER_CODES)[number]

/**
 * Alasan pembatalan. Nilai-nilainya mengikuti `booking.cancelled` di
 * packages/event-contracts, dikurangi `hold_expired`: hold yang kedaluwarsa
 * punya keadaannya sendiri (EXPIRED), karena pertanyaan "berapa hold yang habis
 * tanpa dibayar" adalah metrik bisnis, bukan sekadar alasan pembatalan.
 */
export const CANCELLATION_REASONS = ['user_request', 'payment_failed', 'supplier_rejected'] as const
export type CancellationReason = (typeof CANCELLATION_REASONS)[number]

/**
 * Hasil price check terakhir, dan apakah pengguna sudah menyetujuinya.
 *
 * - `verified`: harga supplier sama dengan harga yang disetujui. Hanya ini yang
 *   boleh lanjut ke hold.
 * - `changed`: harga berbeda. Alur berhenti sampai pengguna menyetujui [quoted]
 *   atau membatalkan (FR-14, US-02).
 * - `accepted`: pengguna menyetujui harga baru, tetapi harga itu BELUM
 *   diverifikasi ulang. Step 17: harga bisa berubah lagi di antara persetujuan
 *   dan pembayaran, jadi persetujuan menuntut price check berikutnya — dan
 *   keadaan ini yang membuat tuntutan itu ditegakkan domain, bukan diingat
 *   pemanggil.
 */
export type PriceCheck =
  | { readonly kind: 'verified' }
  | { readonly kind: 'changed'; readonly quoted: PriceBreakdown }
  | { readonly kind: 'accepted' }

export interface Failure {
  readonly reason: string
}

export interface Review {
  /** Keadaan asal. Menentukan apa yang harus diperiksa manusia lebih dulu. */
  readonly from: 'PAID' | 'FAILED'
  readonly reason: string
}

/** Bidang yang dimiliki pemesanan di setiap keadaan. */
export interface BookingBase {
  readonly id: string
  readonly userId: string
  readonly supplier: SupplierCode
  readonly propertyId: string
  /**
   * Kota properti. Ditambahkan Step 17: aturan markup pricing-service dicakup
   * per kota, dan price check ulang — setelah persetujuan harga dan saat hold —
   * harus menghitung harga jual dengan aturan yang sama dengan pencarian.
   */
  readonly city: string
  readonly ratePlanRef: string
  /**
   * Ketentuan tawaran saat price check (Step 23) — bahan e-voucher. Tidak ada
   * hanya pada pemesanan yang dibuat sebelum Step 23; voucher-nya menyebut
   * ketentuan itu tidak tercatat alih-alih menebaknya.
   */
  readonly terms?: OfferTerms
  readonly stay: StayDates
  readonly guests: GuestDetails
  /**
   * Harga yang TERAKHIR disetujui pengguna. Inilah satu-satunya nilai yang
   * boleh ditagih (G2). Berubah hanya lewat persetujuan eksplisit.
   */
  readonly price: PriceBreakdown
  readonly idempotencyKey: IdempotencyKey
  /**
   * Naik satu pada setiap transisi. Dipakai repository sebagai kunci optimistik
   * DAN sebagai nomor urut peristiwa di booking_events — dua jalur yang
   * memindahkan pemesanan yang sama bersamaan (Step 17: kedaluwarsa hold lewat
   * keyspace notification dan lewat penyapu) tidak dapat sama-sama menang.
   */
  readonly version: number
  readonly createdAt: Date
  readonly updatedAt: Date
}

/** Bidang yang hanya dimiliki sebagian keadaan. */
export interface StateFields {
  readonly priceCheck: PriceCheck
  readonly holdRef: string
  readonly heldUntil: Date
  readonly paymentId: string
  readonly supplierRef: string
  readonly failure: Failure
  readonly refundId: string
  readonly cancellation: CancellationReason
  readonly review: Review
}

type StateField = keyof StateFields

/** Bidang yang dimiliki keadaan ini, dan larangan atas seluruh bidang lainnya. */
type State<S extends BookingStatus, Own extends StateField = never> = BookingBase & {
  readonly status: S
} & Pick<StateFields, Own> &
  Partial<Readonly<Record<Exclude<StateField, Own>, never>>>

export type Booking =
  | State<'DRAFT'>
  | State<'PRICE_CHECKED', 'priceCheck'>
  | State<'HELD', 'holdRef' | 'heldUntil'>
  | State<'PAID', 'paymentId'>
  | State<'CONFIRMED', 'paymentId' | 'supplierRef'>
  | State<'FAILED', 'paymentId' | 'failure'>
  | State<'REFUNDED', 'paymentId' | 'failure' | 'refundId'>
  | State<'CANCELLED', 'cancellation'>
  // Hold yang kedaluwarsa tetap membawa rujukannya: pelepasan hold di supplier
  // (Step 17) membutuhkan token itu SETELAH keadaan berpindah.
  | State<'EXPIRED', 'holdRef' | 'heldUntil'>
  | State<'NEEDS_REVIEW', 'paymentId' | 'review'>

export type BookingIn<S extends BookingStatus> = Extract<Booking, { readonly status: S }>

export type DraftBooking = BookingIn<'DRAFT'>

/**
 * Bidang dasar tanpa bidang khas keadaan, untuk menyusun keadaan berikutnya.
 *
 * Disusun ulang secara eksplisit alih-alih menyebar pemesanan lama: spread
 * akan ikut membawa `holdRef` dari HELD ke PAID. Larangan `?: never` di atas
 * membuat kesalahan itu tertangkap compiler, tetapi lebih baik tidak
 * membuatnya sejak awal.
 */
export function baseOf(booking: Booking): BookingBase {
  return {
    id: booking.id,
    userId: booking.userId,
    supplier: booking.supplier,
    propertyId: booking.propertyId,
    city: booking.city,
    ratePlanRef: booking.ratePlanRef,
    ...(booking.terms === undefined ? {} : { terms: booking.terms }),
    stay: booking.stay,
    guests: booking.guests,
    price: booking.price,
    idempotencyKey: booking.idempotencyKey,
    version: booking.version,
    createdAt: booking.createdAt,
    updatedAt: booking.updatedAt,
  }
}
