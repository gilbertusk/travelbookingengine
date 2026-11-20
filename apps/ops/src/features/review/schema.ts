import { z } from 'zod'

/** `/ops/bookings/review` dan `/ops/bookings/:id` (booking-service, Step 27). */

const money = z.object({ amountMinor: z.number(), currency: z.string() })

export const reviewCaseSchema = z.object({
  booking: z.object({
    id: z.string(),
    status: z.string(),
    supplier: z.string(),
    propertyId: z.string(),
    city: z.string(),
    checkIn: z.string(),
    checkOut: z.string(),
    guests: z.number(),
    price: z.object({ total: money }),
    supplierRef: z.string().nullable(),
    userId: z.string(),
    version: z.number(),
    createdAt: z.string(),
    updatedAt: z.string(),
    leadGuest: z.object({ fullName: z.string(), email: z.string() }),
    paymentId: z.string().nullable(),
    review: z.object({ from: z.string(), reason: z.string() }).nullable(),
    failureReason: z.string().nullable(),
    refundId: z.string().nullable(),
  }),
  supplierIdempotencyKey: z.string(),
  saga: z
    .object({
      phase: z.string(),
      step: z.string(),
      attempts: z.number(),
      lastError: z.string().nullable(),
      compensation: z.string().optional(),
      stepStatus: z.string().optional(),
      updatedAt: z.string(),
    })
    .nullable(),
  trail: z.array(
    z.object({
      sequence: z.number(),
      type: z.string(),
      occurredAt: z.string(),
      payload: z.unknown(),
    }),
  ),
})

export type ReviewCase = z.infer<typeof reviewCaseSchema>

export const reviewQueueSchema = z.array(reviewCaseSchema)

/** `/ops/payments/:id` — bentuk payment-service, hanya bidang yang ditampilkan. */
export const paymentSchema = z.object({
  payment: z.object({
    id: z.string(),
    status: z.string(),
    amount: money,
    /** Tidak ada untuk PENDING dan FAILED (lihat payment-routes.ts). */
    refunds: z.array(z.object({ status: z.string(), amount: money })).optional(),
  }),
})

/** Arti `review.from` dalam kalimat untuk operator — sama dengan apps/web (Step 26). */
export const REVIEW_CONCERNS: Readonly<Record<string, string>> = {
  PAID: 'Kamar belum pasti: supplier tidak menjawab konfirmasi. Uang sudah diterima.',
  FAILED: 'Refund kompensasi tidak tuntas setelah pemesanan gagal.',
  CANCELLING: 'Pembatalan oleh pengguna tidak tuntas: kamar mungkin sudah lepas, refund belum.',
}
