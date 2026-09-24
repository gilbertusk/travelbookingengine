import { EXPONENT, minorUnitsPerMajor, type Currency } from './currency.js'
import type { Money } from './money.js'

/**
 * Pemformatan untuk tampilan.
 *
 * Terpisah dari perhitungan, dan sengaja tidak dapat dipakai sebaliknya:
 * tidak ada fungsi yang mengurai string terformat kembali menjadi uang.
 * String yang sudah diberi pemisah ribuan dan simbol mata uang adalah
 * keluaran akhir; menguraikannya kembali berarti menebak lokal yang
 * membuatnya.
 */

/** Nilai dalam satuan utama, hanya untuk diserahkan ke Intl. */
function toMajor(value: Money): number {
  return value.amountMinor / minorUnitsPerMajor(value.currency)
}

export interface FormatOptions {
  readonly locale?: string
  /** `symbol` menghasilkan "Rp 2.893.400", `code` menghasilkan "IDR 2.893.400". */
  readonly display?: 'symbol' | 'code' | 'none'
}

const DEFAULT_LOCALE: Readonly<Record<Currency, string>> = { IDR: 'id-ID', USD: 'en-US' }

export function format(value: Money, options: FormatOptions = {}): string {
  const locale = options.locale ?? DEFAULT_LOCALE[value.currency]
  const display = options.display ?? 'symbol'
  const fractionDigits = EXPONENT[value.currency]

  if (display === 'none') {
    return new Intl.NumberFormat(locale, {
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    }).format(toMajor(value))
  }

  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: value.currency,
    currencyDisplay: display === 'code' ? 'code' : 'symbol',
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(toMajor(value))
}

/**
 * Bentuk desimal polos, untuk dikirim ke supplier yang memintanya begitu.
 *
 * Disusun dengan operasi string, bukan pembagian pecahan — pembagian
 * menghasilkan nilai seperti 267.82999999999998 pada sebagian angka.
 */
export function toDecimalString(value: Money): string {
  const exponent = EXPONENT[value.currency]
  const sign = value.amountMinor < 0 ? '-' : ''
  const digits = String(Math.abs(value.amountMinor)).padStart(exponent + 1, '0')

  if (exponent === 0) return `${sign}${digits}`

  return `${sign}${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`
}
