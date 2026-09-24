import { money } from '@tbe/money'
import type { MarkupRule } from '../domain/markup.js'
import type { ExchangeRate, TaxPolicy } from '../domain/pricing.js'
import type {
  MarkupRuleStore,
  PricingDeps,
  RateProvider,
  TaxPolicyProvider,
} from '../application/ports.js'

/**
 * Perkakas uji.
 *
 * Penyimpanan menghitung berapa kali ia dibaca. Itu bukan detail: syarat
 * "memproses 500 rate plan tanpa kueri per item" hanya dapat dibuktikan
 * dengan menghitung pembacaannya, bukan dengan mengukur waktunya — pengukuran
 * waktu akan lulus pada mesin cepat meski kuerinya berulang.
 */

export const USD_TO_IDR: ExchangeRate = {
  from: 'USD',
  to: 'IDR',
  rate: { amount: 16_000, scale: 0 },
  asOf: '2026-09-01T00:00:00.000Z',
}

export const PPN: TaxPolicy = { name: 'PPN', basisPoints: 1_100 }

export interface CountingRateProvider extends RateProvider {
  readonly reads: { count: number }
}

export function countingRates(rates: readonly ExchangeRate[] = [USD_TO_IDR]): CountingRateProvider {
  const reads = { count: 0 }

  return {
    reads,
    async current() {
      reads.count += 1
      return await Promise.resolve(rates)
    },
  }
}

export interface CountingRuleStore extends MarkupRuleStore {
  readonly reads: { count: number }
}

export function countingRules(rules: readonly MarkupRule[] = []): CountingRuleStore {
  const reads = { count: 0 }
  const stored = [...rules]

  return {
    reads,
    async listActive() {
      reads.count += 1
      return await Promise.resolve(stored.filter((rule) => rule.isActive))
    },
    async listAll() {
      reads.count += 1
      return await Promise.resolve(stored)
    },
    async create(rule) {
      const created: MarkupRule = { ...rule, id: `rule-${String(stored.length + 1)}` }
      stored.push(created)
      return await Promise.resolve(created)
    },
    async update(id, patch) {
      const index = stored.findIndex((rule) => rule.id === id)
      if (index === -1) return undefined

      const current = stored[index]
      if (current === undefined) return undefined

      const next: MarkupRule = {
        ...current,
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.priority === undefined ? {} : { priority: patch.priority }),
        ...(patch.percentageBasisPoints === undefined
          ? {}
          : { percentageBasisPoints: patch.percentageBasisPoints }),
        ...(patch.isActive === undefined ? {} : { isActive: patch.isActive }),
      }
      stored[index] = next

      return await Promise.resolve(next)
    },
    async remove(id) {
      const index = stored.findIndex((rule) => rule.id === id)
      if (index === -1) return await Promise.resolve(false)

      const current = stored[index]
      if (current !== undefined) stored[index] = { ...current, isActive: false }

      return await Promise.resolve(true)
    },
  }
}

export function fixedTaxes(policy: TaxPolicy = PPN): TaxPolicyProvider {
  return { forCity: () => policy }
}

export function percentageRule(overrides: Partial<MarkupRule> = {}): MarkupRule {
  return {
    id: 'rule-default',
    name: 'markup global',
    priority: 0,
    scope: {},
    kind: 'percentage',
    percentageBasisPoints: 1_500,
    isActive: true,
    ...overrides,
  }
}

export function fixedRule(overrides: Partial<MarkupRule> = {}): MarkupRule {
  return {
    id: 'rule-fixed',
    name: 'markup nominal',
    priority: 0,
    scope: {},
    kind: 'fixed',
    fixedAmount: money(50_000, 'IDR'),
    isActive: true,
    ...overrides,
  }
}

export interface Harness {
  readonly deps: PricingDeps
  readonly rates: CountingRateProvider
  readonly rules: CountingRuleStore
}

export function harness(
  options: {
    readonly rules?: readonly MarkupRule[]
    readonly rates?: readonly ExchangeRate[]
    readonly tax?: TaxPolicy
    readonly sellingCurrency?: 'IDR' | 'USD'
  } = {},
): Harness {
  const rates = countingRates(options.rates ?? [USD_TO_IDR])
  const rules = countingRules(options.rules ?? [])

  return {
    rates,
    rules,
    deps: {
      rates,
      markupRules: rules,
      taxes: fixedTaxes(options.tax ?? PPN),
      settings: {
        sellingCurrency: options.sellingCurrency ?? 'IDR',
        rounding: 'half_even',
      },
    },
  }
}
