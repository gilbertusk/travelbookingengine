import { z } from 'zod'

/** `/ops/pricing/markup-rules` dan pratinjaunya (pricing-service, Step 27). */

const money = z.object({ amountMinor: z.number(), currency: z.string() })

export const SUPPLIERS = ['SKY', 'NOVA', 'ORBIT', 'LUNA', 'ZEPH'] as const

export const markupRuleSchema = z.object({
  id: z.string(),
  name: z.string(),
  priority: z.number(),
  scope: z.object({ supplier: z.string().optional(), city: z.string().optional() }),
  kind: z.enum(['percentage', 'fixed']),
  percentageBasisPoints: z.number().optional(),
  fixedAmount: money.optional(),
  isActive: z.boolean(),
})

export type MarkupRule = z.infer<typeof markupRuleSchema>

const side = z.union([
  z.object({ ok: z.literal(true), total: money, markup: money, ruleId: z.string().nullable() }),
  z.object({ ok: z.literal(false), error: z.object({ kind: z.string() }) }),
])

export const previewSchema = z.object({
  rows: z.array(z.object({ ref: z.string(), before: side, after: side, isChanged: z.boolean() })),
  changedCount: z.number(),
  isTieBreakUncertain: z.boolean(),
})

export type Preview = z.infer<typeof previewSchema>

export interface RuleDraft {
  readonly name: string
  readonly priority: number
  readonly city: string
  readonly supplier: string
  readonly percent: string
}

/**
 * Draf formulir → badan aturan. Persen ditulis manusia ("12,5"), disimpan
 * dalam basis poin (1250) — bilangan bulat, seperti pricing-service.
 * `undefined` bila draf belum dapat diterapkan.
 */
export function ruleBodyOf(draft: RuleDraft) {
  const basisPoints = Math.round(Number(draft.percent.replace(',', '.')) * 100)
  if (draft.name.trim() === '' || !Number.isFinite(basisPoints) || basisPoints < 0) {
    return undefined
  }
  return {
    name: draft.name.trim(),
    priority: draft.priority,
    kind: 'percentage' as const,
    percentageBasisPoints: basisPoints,
    scope: {
      ...(draft.city.trim() === '' ? {} : { city: draft.city.trim() }),
      ...(draft.supplier === '' ? {} : { supplier: draft.supplier }),
    },
  }
}

/** Sampel pratinjau: satu per supplier, di kota dan harga yang dipilih operator. */
export function samplesFor(city: string, amountMinor: number) {
  return SUPPLIERS.map((supplier) => ({
    ref: supplier,
    supplier,
    city,
    supplierTotal: { amountMinor, currency: 'IDR' },
  }))
}
