import { z } from 'zod'
import { BOOKING_STATUSES, cancellationSchema, moneySchema } from '@/features/booking/types'

/**
 * Bentuk jawaban daftar pemesanan, pratinjau pembatalan, dan tautan voucher
 * (Step 26). Diurai, bukan dipercaya — alasan yang sama dengan
 * features/booking/types.ts.
 */

export const BOOKING_GROUPS = ['upcoming', 'past', 'cancelled'] as const
export type BookingGroup = (typeof BOOKING_GROUPS)[number]

export const listItemSchema = z.object({
  id: z.string(),
  status: z.enum(BOOKING_STATUSES),
  isFinal: z.boolean(),
  /** Dari katalog. `null` bila katalog tidak menjawab — kota tetap ada. */
  propertyName: z.string().nullable(),
  city: z.string(),
  roomTypeName: z.string().nullable(),
  checkIn: z.string(),
  checkOut: z.string(),
  guests: z.number().int(),
  supplierRef: z.string().nullable(),
  total: moneySchema,
  refund: z.enum(['pending', 'completed', 'review']).nullable(),
  review: z.enum(['room', 'refund', 'cancellation']).nullable(),
  cancellation: cancellationSchema.nullable(),
})

export type BookingListItem = z.infer<typeof listItemSchema>

export const listPageSchema = z.object({
  items: z.array(listItemSchema),
  nextCursor: z.string().nullable(),
})

export type BookingListPage = z.infer<typeof listPageSchema>

const scheduledTierSchema = z.object({ percent: z.number().int(), until: z.string() })

export const quoteSchema = z.object({
  refund: moneySchema,
  percent: z.number().int(),
  until: z.string(),
  next: z.object({ percent: z.number().int() }).nullable(),
  nothingBack: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('non_refundable') }),
      z.object({ kind: z.literal('past_deadline'), lastRefund: scheduledTierSchema }),
    ])
    .nullable(),
  tiers: z.array(scheduledTierSchema),
  checkInStartsAt: z.string(),
  timeZone: z.string(),
})

export type RefundQuote = z.infer<typeof quoteSchema>

export const previewSchema = z.discriminatedUnion('cancellable', [
  z.object({
    bookingId: z.string(),
    cancellable: z.literal(true),
    paid: moneySchema,
    quote: quoteSchema,
    serverTime: z.string(),
  }),
  z.object({
    bookingId: z.string(),
    cancellable: z.literal(false),
    reason: z.string(),
    message: z.string(),
    serverTime: z.string(),
  }),
])

export type CancellationPreview = z.infer<typeof previewSchema>

export const voucherLinkSchema = z.object({ url: z.url(), expiresAt: z.string() })
