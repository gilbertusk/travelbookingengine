import type { Currency, RoundingMode } from '@tbe/money'
import type { MarkupRule } from '../domain/markup.js'
import type { ExchangeRate, TaxPolicy } from '../domain/pricing.js'

/**
 * Port yang dibutuhkan penetapan harga.
 *
 * Ketiganya berbentuk "muat semuanya sekali", bukan "cari satu per satu". Itu
 * disengaja dan merupakan syarat, bukan optimasi: penetapan harga berada di
 * jalur kritis pencarian dan menerima ratusan rate plan dalam satu panggilan.
 * Port yang berbentuk `findRuleFor(supplier, city)` akan menghasilkan satu
 * kueri per rate plan, dan lima ratus kueri dalam satu permintaan pencarian
 * adalah cara paling pasti membuat pencarian melewati anggaran waktunya.
 */

export interface RateProvider {
  /**
   * Seluruh kurs yang berlaku sekarang.
   *
   * Sumbernya boleh statis untuk MVP, tetapi antarmukanya dibuat seolah dari
   * luar — supaya menggantinya dengan penyedia sungguhan nanti tidak
   * mengubah satu baris pun di lapisan ini.
   */
  current(): Promise<readonly ExchangeRate[]>
}

export interface MarkupRuleStore {
  /** Seluruh aturan aktif. Tabelnya kecil; penyaringan terjadi di memori. */
  listActive(): Promise<readonly MarkupRule[]>
  listAll(): Promise<readonly MarkupRule[]>
  create(rule: Omit<MarkupRule, 'id'>): Promise<MarkupRule>
  update(id: string, patch: MarkupRulePatch): Promise<MarkupRule | undefined>
  remove(id: string): Promise<boolean>
}

export interface MarkupRulePatch {
  readonly name?: string | undefined
  readonly priority?: number | undefined
  readonly percentageBasisPoints?: number | undefined
  readonly isActive?: boolean | undefined
}

export interface TaxPolicyProvider {
  /** Kebijakan pajak untuk satu kota. Dimuat sekali per panggilan. */
  forCity(city: string): TaxPolicy
}

export interface PricingSettings {
  readonly sellingCurrency: Currency
  readonly rounding: RoundingMode
}

export interface PricingDeps {
  readonly rates: RateProvider
  readonly markupRules: MarkupRuleStore
  readonly taxes: TaxPolicyProvider
  readonly settings: PricingSettings
}
