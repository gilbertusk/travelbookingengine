import type { Currency, Money } from '@tbe/money'
import { resolveMarkup, selectRule, type MarkupRule } from '../domain/markup.js'
import {
  calculatePrice,
  type ExchangeRate,
  type PriceBreakdown,
  type PriceFailure,
} from '../domain/pricing.js'
import type { PricingDeps } from './ports.js'

/**
 * Menetapkan harga jual untuk sekumpulan rate plan.
 *
 * Kurs dan aturan markup dimuat **sekali per panggilan**, bukan per rate plan.
 * Ini syarat, bukan optimasi: lima ratus rate plan dengan satu kueri masing-
 * masing berarti lima ratus perjalanan ke basis data di dalam satu permintaan
 * pencarian — dan pencarian punya anggaran waktu tiga detik untuk seluruh
 * fan-out ke lima supplier.
 *
 * Rate plan yang gagal dihitung TIDAK menggagalkan seluruh panggilan. Satu
 * kurs yang hilang untuk satu supplier tidak boleh menghapus hasil dari empat
 * supplier lain — hasilnya dilaporkan per item, dan pemanggil memutuskan.
 */

export interface RatePlanPriceRequest {
  /** Pengenal apa pun milik pemanggil; dikembalikan apa adanya. */
  readonly ref: string
  readonly supplier: string
  readonly city: string
  readonly supplierTotal: Money
}

export type RatePlanPriceResult =
  | { readonly ref: string; readonly ok: true; readonly breakdown: PriceBreakdown }
  | { readonly ref: string; readonly ok: false; readonly error: PriceFailure }

export interface PricingRun {
  readonly results: readonly RatePlanPriceResult[]
  /** Kurs yang benar-benar dipakai, untuk penelusuran. */
  readonly ratesUsed: readonly ExchangeRate[]
}

export async function priceRatePlans(
  deps: PricingDeps,
  requests: readonly RatePlanPriceRequest[],
): Promise<PricingRun> {
  // Dua pemuatan. Bukan dua per rate plan.
  const [rates, rules] = await Promise.all([deps.rates.current(), deps.markupRules.listActive()])

  const rateIndex = indexRates(rates)
  const sellingCurrency = deps.settings.sellingCurrency

  const results = requests.map((request) =>
    priceOne(request, { rules, rateIndex, sellingCurrency, deps }),
  )

  return { results, ratesUsed: rates }
}

interface RunContext {
  readonly rules: readonly MarkupRule[]
  readonly rateIndex: ReadonlyMap<string, ExchangeRate>
  readonly sellingCurrency: Currency
  readonly deps: PricingDeps
}

function priceOne(request: RatePlanPriceRequest, context: RunContext): RatePlanPriceResult {
  const from = request.supplierTotal.currency
  const rate = context.rateIndex.get(pairKey(from, context.sellingCurrency))

  const markup = resolveMarkup(
    selectRule(context.rules, { supplier: request.supplier, city: request.city }),
  )

  const result = calculatePrice({
    supplierTotal: request.supplierTotal,
    sellingCurrency: context.sellingCurrency,
    ...(rate === undefined ? {} : { exchangeRate: rate }),
    markup,
    tax: context.deps.taxes.forCity(request.city),
    rounding: context.deps.settings.rounding,
  })

  return result.ok
    ? { ref: request.ref, ok: true, breakdown: result.breakdown }
    : { ref: request.ref, ok: false, error: result.error }
}

function indexRates(rates: readonly ExchangeRate[]): ReadonlyMap<string, ExchangeRate> {
  const index = new Map<string, ExchangeRate>()

  for (const rate of rates) {
    const key = pairKey(rate.from, rate.to)
    const existing = index.get(key)

    // Kurs terbaru menang. Tabel kurs menyimpan riwayat, dan riwayat itulah
    // yang membuat harga pemesanan lama tetap dapat dijelaskan.
    if (existing === undefined || rate.asOf > existing.asOf) index.set(key, rate)
  }

  return index
}

function pairKey(from: Currency, to: Currency): string {
  return `${from}->${to}`
}
