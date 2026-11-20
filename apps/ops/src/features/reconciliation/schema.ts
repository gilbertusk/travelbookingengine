import { z } from 'zod'

/** `GET /ops/bookings/reconciliation` (booking-service, Step 28). */

export const FINDING_LABELS = {
  missing_at_supplier: 'Tidak ada di supplier',
  cancelled_at_supplier: 'Dibatalkan di supplier',
  active_at_supplier: 'Masih aktif di supplier',
  amount_mismatch: 'Nilai berbeda',
  dates_mismatch: 'Tanggal berbeda',
  unverified: 'Supplier tidak dapat ditanya',
} as const

export type FindingKind = keyof typeof FINDING_LABELS

const findingKind = z.enum(Object.keys(FINDING_LABELS) as [FindingKind, ...FindingKind[]])

export const reconciliationSchema = z.array(
  z.object({
    id: z.string(),
    day: z.string(),
    supplier: z.string().nullable(),
    startedAt: z.string(),
    finishedAt: z.string().nullable(),
    checked: z.number().int(),
    matched: z.number().int(),
    mismatched: z.number().int(),
    unverified: z.number().int(),
    flagged: z.number().int(),
    findings: z.array(
      z.object({
        bookingId: z.string(),
        supplier: z.string(),
        localStatus: z.string(),
        kind: findingKind,
        detail: z.string(),
        flagged: z.boolean(),
        recordedAt: z.string(),
      }),
    ),
  }),
)

export type ReconciliationRun = z.infer<typeof reconciliationSchema>[number]

export const runRequestedSchema = z.object({ runId: z.string() })
