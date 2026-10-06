import { z } from 'zod'

/**
 * Bentuk jawaban booking-service, DIURAI — bukan dipercaya.
 *
 * Halaman ini memegang uang pengguna. Bidang yang hilang atau berganti nama
 * di sisi service harus menjadi galat yang terlihat di sini, bukan `undefined`
 * yang diam-diam membuat hitung mundur berhenti atau harga tampil kosong.
 * Ditulis ulang sebagai kontrak, bukan diimpor dari service-nya — alasan yang
 * sama dengan features/search/types.ts.
 */

export const moneySchema = z.object({
  amountMinor: z.number().int(),
  currency: z.enum(['IDR', 'USD']),
})

export type Money = z.infer<typeof moneySchema>

const priceCheckSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('unchanged'), price: moneySchema }),
  z.object({ outcome: z.literal('awaiting_recheck') }),
  z.object({
    outcome: z.literal('changed'),
    previous: moneySchema,
    current: moneySchema,
    /** `null` hanya bila mata uangnya berbeda. */
    difference: moneySchema.nullable(),
  }),
  z.object({ outcome: z.literal('unavailable') }),
])

export type PriceCheckView = z.infer<typeof priceCheckSchema>

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

export const bookingSchema = z.object({
  id: z.string(),
  status: z.enum(BOOKING_STATUSES),
  supplier: z.string(),
  propertyId: z.string(),
  city: z.string(),
  ratePlanRef: z.string(),
  checkIn: z.string(),
  checkOut: z.string(),
  guests: z.number().int(),
  price: z.object({
    total: moneySchema,
    lineItems: z.array(
      z.object({ kind: z.string(), description: z.string(), amount: moneySchema }),
    ),
  }),
  heldUntil: z.string().nullable(),
  priceCheck: priceCheckSchema.nullable(),
  /** Jam booking-service saat respons dibentuk. Lihat server-clock.ts. */
  serverTime: z.string(),
})

export type Booking = z.infer<typeof bookingSchema>

export const statusSchema = z.object({
  id: z.string(),
  status: z.enum(BOOKING_STATUSES),
  isFinal: z.boolean(),
  version: z.number().int(),
  updatedAt: z.string(),
  heldUntil: z.string().nullable(),
  supplierRef: z.string().nullable(),
  failureReason: z.string().nullable(),
  refund: z.enum(['pending', 'completed', 'review']).nullable(),
  saga: z.object({ phase: z.string(), step: z.string() }).nullable(),
  serverTime: z.string(),
})

export type BookingStatusView = z.infer<typeof statusSchema>

export const paymentStartSchema = z.object({
  paymentId: z.string(),
  redirectUrl: z.string(),
  snapToken: z.string(),
  booking: bookingSchema,
})

export type PaymentStart = z.infer<typeof paymentStartSchema>

/**
 * Data tamu (FR-17).
 *
 * Batasnya sama dengan skema `guest` di booking-service (booking-routes.ts):
 * nama 200 karakter, surel 320. Skemanya belum dapat dibagikan — booking-service
 * menulisnya sebaris di rute, bukan di paket bersama — jadi disalin dengan
 * batas yang sama. Yang ditambahkan di sini hanya aturan yang membantu
 * pengguna mengisinya dengan benar; service tetap pemeriksa terakhir.
 */
export const guestSchema = z.object({
  fullName: z
    .string()
    .trim()
    .min(3, 'Tulis nama lengkap sesuai kartu identitas')
    .max(200, 'Nama terlalu panjang'),
  email: z
    .string()
    .trim()
    .min(1, 'Surel dibutuhkan untuk mengirim voucher')
    .max(320, 'Surel terlalu panjang')
    .pipe(z.email('Periksa lagi penulisan surelnya')),
})

export type GuestInput = z.infer<typeof guestSchema>
