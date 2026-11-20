import type { Money } from '@tbe/money'
import { applyChange, type MarkupChange } from '../domain/markup-preview.js'
import type { PriceFailure } from '../domain/pricing.js'
import type { PricingDeps } from './ports.js'
import {
  pricerFor,
  type RatePlanPriceRequest,
  type RatePlanPriceResult,
} from './price-rate-plans.js'

/**
 * Pratinjau dampak perubahan aturan markup (FR-30).
 *
 * Sampelnya diberikan pemanggil — panel operator mengirim kombinasi supplier,
 * kota, dan harga supplier yang ingin dilihat. pricing-service tidak menyimpan
 * harga apa pun (harga dihitung saat pencarian, Step 12), jadi tidak ada
 * "seluruh rate plan hari ini" untuk dipratinjau di sini. Itu batas yang
 * dinyatakan, bukan disembunyikan: lihat Temuan Step 27.
 */

export type PreviewSide =
  | {
      readonly ok: true
      readonly total: Money
      readonly markup: Money
      readonly ruleId: string | null
    }
  | { readonly ok: false; readonly error: PriceFailure }

export interface PreviewRow {
  readonly ref: string
  readonly before: PreviewSide
  readonly after: PreviewSide
  readonly isChanged: boolean
}

export type PreviewOutcome =
  | {
      readonly kind: 'previewed'
      readonly rows: readonly PreviewRow[]
      readonly changedCount: number
      readonly isTieBreakUncertain: boolean
    }
  | { readonly kind: 'rule_not_found' }

export async function previewMarkupChange(
  deps: PricingDeps,
  change: MarkupChange,
  samples: readonly RatePlanPriceRequest[],
): Promise<PreviewOutcome> {
  const [rates, rules] = await Promise.all([deps.rates.current(), deps.markupRules.listAll()])
  const applied = applyChange(rules, change)
  if (!applied.ok) return { kind: 'rule_not_found' }

  const before = pricerFor(deps, { rates, rules })
  const after = pricerFor(deps, { rates, rules: applied.rules })
  const rows = samples.map((sample) => row(sample.ref, before(sample), after(sample)))

  return {
    kind: 'previewed',
    rows,
    changedCount: rows.filter((item) => item.isChanged).length,
    isTieBreakUncertain: applied.isTieBreakUncertain,
  }
}

function row(ref: string, before: RatePlanPriceResult, after: RatePlanPriceResult): PreviewRow {
  const left = side(before)
  const right = side(after)

  return { ref, before: left, after: right, isChanged: !sameSide(left, right) }
}

function side(result: RatePlanPriceResult): PreviewSide {
  if (!result.ok) return { ok: false, error: result.error }

  return {
    ok: true,
    total: result.breakdown.total,
    markup: result.breakdown.markup,
    ruleId: result.breakdown.appliedMarkupRuleId ?? null,
  }
}

function sameSide(a: PreviewSide, b: PreviewSide): boolean {
  if (!a.ok || !b.ok) return a.ok === b.ok
  return a.total.amountMinor === b.total.amountMinor && a.ruleId === b.ruleId
}
