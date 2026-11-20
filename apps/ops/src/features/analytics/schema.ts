import { z } from 'zod'

/** `/ops/analytics/summary` (analytics-service, Step 27). */

const basisPoints = z.number().nullable()

export const summarySchema = z.object({
  range: z.object({ from: z.string(), to: z.string() }),
  summary: z.object({
    funnel: z.array(
      z.object({ stage: z.string(), count: z.number(), fromPreviousBasisPoints: basisPoints }),
    ),
    search: z.object({
      count: z.number(),
      averageLatencyMs: z.number().nullable(),
      averageResults: z.number().nullable(),
    }),
    suppliers: z.array(
      z.object({
        supplier: z.string(),
        searchesAsked: z.number(),
        responseRateBasisPoints: basisPoints,
        bookingsCreated: z.number(),
        priceChangeRateBasisPoints: basisPoints,
        bookingsConfirmed: z.number(),
        bookingsFailed: z.number(),
        confirmUncertain: z.number(),
        degradedTimes: z.number(),
      }),
    ),
    topCities: z.array(z.object({ city: z.string(), searches: z.number() })),
    topStays: z.array(
      z.object({
        city: z.string(),
        checkIn: z.string(),
        checkOut: z.string(),
        searches: z.number(),
      }),
    ),
    failures: z.object({
      bookingsCreated: z.number(),
      bookingsFailed: z.number(),
      failureRateBasisPoints: basisPoints,
      byCause: z.array(z.object({ stage: z.string(), reason: z.string(), count: z.number() })),
    }),
  }),
})

export type AnalyticsReport = z.infer<typeof summarySchema>

/** Nama tahap corong untuk manusia. "Lihat detail" tidak ada — lihat Temuan Step 27. */
export const STAGE_LABELS: Readonly<Record<string, string>> = {
  search: 'Pencarian',
  booking_created: 'Mulai memesan',
  held: 'Kamar ditahan',
  paid: 'Dibayar',
  confirmed: 'Terkonfirmasi',
}
