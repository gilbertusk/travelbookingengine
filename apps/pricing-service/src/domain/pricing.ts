import {
  addPrecise,
  convert,
  multiply,
  round,
  subtract,
  toPrecise,
  zero,
  type Currency,
  type Money,
  type PreciseMoney,
  type RoundingMode,
  type ScaledFactor,
} from '@tbe/money'
import type { ResolvedMarkup } from './markup.js'

/**
 * Urutan perhitungan harga.
 *
 * **harga supplier → konversi mata uang → markup → pajak → pembulatan akhir**
 *
 * Urutannya bukan selera. Menukar markup dan pajak berarti pajak dikenakan
 * atas harga sebelum markup, dan selisihnya bukan pembulatan — ia sebesar
 * markup dikali tarif pajak, yang pada harga hotel berarti puluhan ribu
 * rupiah per pemesanan. Mengonversi setelah markup berarti markup dihitung
 * atas angka dalam mata uang supplier, yang membuat aturan "markup 12%"
 * berarti hal berbeda untuk supplier USD dan supplier IDR.
 *
 * **Pembulatan terjadi sekali, di akhir.** Seluruh langkah di tengah bekerja
 * pada [PreciseMoney] yang membawa skala tambahan. Membulatkan di setiap
 * langkah menghasilkan angka yang berbeda dari perhitungan yang benar — lihat
 * pengujiannya, selisihnya nyata.
 */

export interface ExchangeRate {
  readonly from: Currency
  readonly to: Currency
  /** Satuan utama per satuan utama: 1 USD = 16.000 IDR. */
  readonly rate: ScaledFactor
  readonly asOf: string
}

export interface TaxPolicy {
  readonly name: string
  /** 1100 berarti 11%. */
  readonly basisPoints: number
}

export interface PriceInput {
  readonly supplierTotal: Money
  readonly sellingCurrency: Currency
  /** Wajib ada bila mata uang supplier berbeda dari mata uang jual. */
  readonly exchangeRate?: ExchangeRate | undefined
  readonly markup: ResolvedMarkup
  readonly tax: TaxPolicy
  readonly rounding: RoundingMode
}

/**
 * Rincian harga.
 *
 * Wajib lengkap, bukan hanya total — FR-05 dan DESIGN-SYSTEM.md pada komponen
 * PriceDisplay sama-sama menuntut biaya yang terlihat sejak awal. Harga akhir
 * tanpa rinciannya adalah angka yang tidak dapat dipertanggungjawabkan kepada
 * pengguna maupun kepada operator yang bertanya kenapa segitu.
 *
 * `base + markup + tax` **selalu** sama persis dengan `total`. Lihat catatan
 * pada [calculatePrice] soal ke mana sisa pembulatannya pergi.
 */
export interface PriceBreakdown {
  readonly supplierTotal: Money
  readonly exchangeRate?: ExchangeRate | undefined
  readonly base: Money
  readonly markup: Money
  readonly tax: Money
  readonly total: Money
  readonly appliedMarkupRuleId?: string | undefined
  readonly taxName: string
}

export type PriceFailure =
  | { readonly kind: 'missing_exchange_rate'; readonly from: Currency; readonly to: Currency }
  | { readonly kind: 'wrong_exchange_rate'; readonly expected: string; readonly received: string }
  | { readonly kind: 'markup_currency_mismatch'; readonly expected: Currency }

export type PriceResult =
  | { readonly ok: true; readonly breakdown: PriceBreakdown }
  | { readonly ok: false; readonly error: PriceFailure }

export function calculatePrice(input: PriceInput): PriceResult {
  const converted = toSellingCurrency(input)
  if (!converted.ok) return converted

  const base = converted.value

  const markup = markupAmount(base, input)
  if (!markup.ok) return markup

  const subtotal = addPrecise(base, markup.value)
  const tax = multiply(subtotal, basisPointFactor(input.tax.basisPoints))

  // Satu-satunya pembulatan dalam seluruh rantai.
  const total = round(addPrecise(subtotal, tax), input.rounding)

  return {
    ok: true,
    breakdown: {
      supplierTotal: input.supplierTotal,
      ...(input.exchangeRate === undefined ? {} : { exchangeRate: input.exchangeRate }),
      ...splitComponents(base, markup.value, total, input.rounding),
      total,
      ...(input.markup.kind === 'none' ? {} : { appliedMarkupRuleId: input.markup.ruleId }),
      taxName: input.tax.name,
    },
  }
}

function toSellingCurrency(
  input: PriceInput,
): { ok: true; value: PreciseMoney } | { ok: false; error: PriceFailure } {
  const from = input.supplierTotal.currency

  if (from === input.sellingCurrency) return { ok: true, value: toPrecise(input.supplierTotal) }

  const rate = input.exchangeRate
  if (rate === undefined) {
    return { ok: false, error: { kind: 'missing_exchange_rate', from, to: input.sellingCurrency } }
  }

  // Kurs yang arahnya salah akan menghasilkan angka yang masuk akal secara
  // tipe dan keliru ribuan kali lipat. Diperiksa, bukan dipercaya.
  if (rate.from !== from || rate.to !== input.sellingCurrency) {
    return {
      ok: false,
      error: {
        kind: 'wrong_exchange_rate',
        expected: `${from}->${input.sellingCurrency}`,
        received: `${rate.from}->${rate.to}`,
      },
    }
  }

  return { ok: true, value: convert(input.supplierTotal, input.sellingCurrency, rate.rate) }
}

function markupAmount(
  base: PreciseMoney,
  input: PriceInput,
): { ok: true; value: PreciseMoney } | { ok: false; error: PriceFailure } {
  if (input.markup.kind === 'none') {
    return { ok: true, value: toPrecise(zero(input.sellingCurrency)) }
  }

  if (input.markup.kind === 'percentage') {
    return { ok: true, value: multiply(base, basisPointFactor(input.markup.basisPoints)) }
  }

  // Markup nominal tetap harus sudah dalam mata uang jual. Mengonversinya di
  // sini akan menyembunyikan kesalahan konfigurasi: operator yang menetapkan
  // "Rp 50.000" untuk harga jual dolar sedang salah memasukkan data, bukan
  // meminta konversi.
  if (input.markup.amount.currency !== input.sellingCurrency) {
    return {
      ok: false,
      error: { kind: 'markup_currency_mismatch', expected: input.sellingCurrency },
    }
  }

  return { ok: true, value: toPrecise(input.markup.amount) }
}

/**
 * Memecah total menjadi komponen yang dapat ditampilkan.
 *
 * `base` dan `markup` dibulatkan sendiri; `tax` dihitung sebagai sisanya.
 * Akibatnya `base + markup + tax` SELALU sama persis dengan `total` — dan itu
 * yang terpenting, karena rincian yang tidak menjumlah ke totalnya adalah
 * rincian yang membuat pengguna berhenti percaya pada angkanya.
 *
 * Sisa pembulatan — paling besar satu satuan terkecil — jatuh ke pajak. Itu
 * keputusan yang disengaja: pajak adalah komponen terakhir yang dihitung, dan
 * menggesernya sebesar satu rupiah tidak mengubah kewajiban apa pun.
 */
function splitComponents(
  base: PreciseMoney,
  markup: PreciseMoney,
  total: Money,
  rounding: RoundingMode,
): { base: Money; markup: Money; tax: Money } {
  const roundedBase = round(base, rounding)
  const roundedMarkup = round(markup, rounding)

  return {
    base: roundedBase,
    markup: roundedMarkup,
    tax: subtract(subtract(total, roundedBase), roundedMarkup),
  }
}

/** 1250 basis poin menjadi faktor 0,125 untuk markup — atau 1,125 untuk total. */
function basisPointFactor(basisPoints: number): ScaledFactor {
  return { amount: basisPoints, scale: 4 }
}

/** Dipakai pengujian dan dokumentasi: 11% ditulis 1100. */
export function percentToBasisPoints(percent: number): number {
  return Math.round(percent * 100)
}
