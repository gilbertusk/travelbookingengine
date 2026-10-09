import { z } from 'zod'
import { moneySchema } from './money.js'

/**
 * Model kanonik.
 *
 * Penamaan mengikuti glosarium PRD Bab 8 — Property, Room Type, Rate Plan,
 * Availability, Cancellation Policy, Booking Reference — dan tidak boleh
 * menyimpang darinya. Istilah yang berbeda di dokumen dan di kode memaksa
 * setiap pembaca menerjemahkan di kepalanya, dan terjemahan itu kadang salah.
 *
 * Didefinisikan dengan Zod, bukan hanya tipe TypeScript, karena data ini
 * datang dari sumber yang tidak tepercaya. Tipe TypeScript hilang saat
 * dijalankan; yang menghadapi respons supplier yang cacat adalah skema.
 *
 * Seluruh pengenal di sini adalah pengenal MILIK SUPPLIER, apa adanya.
 * Pemetaan ke pengenal properti internal bukan tanggung jawab lapisan ini —
 * itu milik katalog internal pada Step 12b (lihat ADR-0001).
 */

export const SUPPLIER_CODES = ['SKY', 'NOVA', 'ORBIT', 'LUNA', 'ZEPH'] as const
export type SupplierCode = (typeof SUPPLIER_CODES)[number]

export const supplierCodeSchema = z.enum(SUPPLIER_CODES)

/** Tanggal kalender, bukan titik waktu. CONVENTIONS.md bagian 10. */
export const calendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'bukan tanggal kalender')

/**
 * Kebijakan pembatalan.
 *
 * Union, bukan objek dengan `refundable: boolean` dan field opsional, karena
 * "boleh dibatalkan" dan "tenggat pembatalannya kapan" hanya masuk akal
 * bersama-sama. Bentuk ini membuat mustahil menulis rate plan yang tidak dapat
 * dikembalikan tetapi punya tenggat pembatalan gratis.
 */
export const cancellationPolicySchema = z.discriminatedUnion('refundable', [
  z.object({ refundable: z.literal(false) }),
  z.object({
    refundable: z.literal(true),
    /**
     * Hari sebelum check-in ketika pembatalan masih gratis. Tidak setiap
     * supplier menyebutkannya; yang tidak menyebutkan meninggalkannya kosong
     * alih-alih menebak angka.
     */
    freeCancellationDays: z.number().int().nonnegative().optional(),
  }),
])

export type CancellationPolicy = z.infer<typeof cancellationPolicySchema>

/**
 * Ketersediaan.
 *
 * Objek, bukan angka telanjang, supaya bertambahnya keterangan pada Step 13 —
 * misalnya menginap minimum — tidak memaksa mengubah bentuk di seluruh sistem.
 */
export const availabilitySchema = z.object({
  unitsLeft: z.number().int().nonnegative(),
})

export type Availability = z.infer<typeof availabilitySchema>

export const ratePlanSchema = z.object({
  /** Pengenal versi supplier. Dipakai apa adanya untuk price check dan hold. */
  supplierRatePlanId: z.string().min(1),
  name: z.string(),
  total: moneySchema,
  nightly: moneySchema,
  cancellationPolicy: cancellationPolicySchema,
  breakfastIncluded: z.boolean(),
  availability: availabilitySchema,
})

export type RatePlan = z.infer<typeof ratePlanSchema>

export const roomTypeSchema = z.object({
  supplierRoomTypeId: z.string().min(1),
  name: z.string(),
  maxGuests: z.number().int().positive().optional(),
  ratePlans: z.array(ratePlanSchema),
})

export type RoomType = z.infer<typeof roomTypeSchema>

export const coordinatesSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
})

/**
 * Properti sebagaimana dilihat satu supplier.
 *
 * Data pendukung — nama, koordinat, alamat — disertakan meski adapter tidak
 * memakainya, karena Step 12b membutuhkannya untuk membangun tabel pemetaan
 * dan untuk menampilkan properti yang belum terpetakan apa adanya.
 */
export const supplierPropertySchema = z.object({
  supplier: supplierCodeSchema,
  supplierPropertyId: z.string().min(1),
  name: z.string().min(1),
  starRating: z.number().min(0).max(5).optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  coordinates: coordinatesSchema.optional(),
  amenities: z.array(z.string()),
  roomTypes: z.array(roomTypeSchema),
})

export type SupplierProperty = z.infer<typeof supplierPropertySchema>

export const searchResultSchema = z.object({
  supplier: supplierCodeSchema,
  checkIn: calendarDateSchema,
  checkOut: calendarDateSchema,
  properties: z.array(supplierPropertySchema),
})

export type SupplierSearchResult = z.infer<typeof searchResultSchema>

/**
 * Hasil price check.
 *
 * `changed` adalah jawaban yang sah, bukan kegagalan — Rate Change adalah
 * kondisi normal menurut glosarium. Harga baru selalu disertakan, juga ketika
 * tidak berubah, supaya pemanggil tidak perlu menyimpan harga lama untuk
 * mengetahui berapa yang harus ditagih.
 */
export const priceCheckResultSchema = z.object({
  supplierRatePlanId: z.string().min(1),
  total: moneySchema,
  changed: z.boolean(),
  /**
   * Kebijakan pembatalan rate plan, dari jawaban supplier SAAT price check
   * (Step 25). Wajib, bukan opsional: kebijakan inilah yang menentukan berapa
   * yang dikembalikan saat pengguna membatalkan, dan satu-satunya sumber lain
   * adalah hasil pencarian yang dikirim ulang peramban — yang dapat diubah
   * siapa pun yang memanggil API langsung. Jawaban tanpa kebijakan ditolak
   * adapter, tidak ditebak.
   */
  cancellationPolicy: cancellationPolicySchema,
})

export type PriceCheckResult = z.infer<typeof priceCheckResultSchema>

export const holdResultSchema = z.object({
  /** Referensi hold versi supplier, dipakai saat book. */
  supplierHoldId: z.string().min(1),
  /** Titik waktu sungguhan, berbeda dari tanggal menginap. */
  expiresAt: z.iso.datetime(),
  total: moneySchema,
})

export type HoldResult = z.infer<typeof holdResultSchema>

export const BOOKING_STATUSES = ['CONFIRMED', 'CANCELLED'] as const
export const bookingStatusSchema = z.enum(BOOKING_STATUSES)
export type BookingStatus = z.infer<typeof bookingStatusSchema>

/**
 * Hasil pemesanan.
 *
 * `bookingReference` adalah pengenal terbitan supplier — bukti pemesanan yang
 * sah menurut glosarium, dan berbeda dari pengenal internal kita.
 */
export const bookingResultSchema = z.object({
  supplier: supplierCodeSchema,
  bookingReference: z.string().min(1),
  status: bookingStatusSchema,
  total: moneySchema,
  checkIn: calendarDateSchema.optional(),
  checkOut: calendarDateSchema.optional(),
  guestName: z.string().optional(),
})

export type BookingResult = z.infer<typeof bookingResultSchema>

/**
 * Menyusun kebijakan pembatalan.
 *
 * Ada di sini, bukan diulang di lima adapter, karena bentuk union-nya membuat
 * penyusunan manual bertele-tele — dan yang bertele-tele akan disalin-tempel,
 * lalu satu salinan akan menyimpang.
 */
export function cancellationPolicy(
  refundable: boolean,
  freeCancellationDays?: number,
): CancellationPolicy {
  if (!refundable) return { refundable: false }

  return {
    refundable: true,
    ...(freeCancellationDays === undefined ? {} : { freeCancellationDays }),
  }
}
