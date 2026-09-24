import { z } from 'zod'

/**
 * Uang.
 *
 * SEMENTARA: akan digantikan packages/money pada Step 12. Yang didefinisikan
 * di sini hanya yang dibutuhkan lapisan adapter — satuan terkecil dan kode
 * mata uang. Konversi antar mata uang BUKAN tanggung jawab lapisan ini;
 * adapter hanya menandai mata uang yang dipakai supplier apa adanya.
 *
 * Nilai disimpan sebagai bilangan bulat dalam satuan terkecil, tidak pernah
 * sebagai pecahan. CONVENTIONS.md bagian 10: harga 267.83 yang disimpan
 * sebagai `number` akan menjadi 267.82999999999998 pada penjumlahan tertentu,
 * dan selisih satu sen per pemesanan menjadi selisih nyata pada rekonsiliasi.
 */

export const CURRENCIES = ['IDR', 'USD'] as const
export type Currency = (typeof CURRENCIES)[number]

/** Banyak angka desimal pada satuan terkecil tiap mata uang. */
const EXPONENT: Readonly<Record<Currency, number>> = { IDR: 0, USD: 2 }

export const currencySchema = z.enum(CURRENCIES)

export const moneySchema = z.object({
  /** Selalu bilangan bulat. Untuk USD berarti sen, untuk IDR berarti rupiah. */
  amountMinor: z.number().int(),
  currency: currencySchema,
})

export type Money = z.infer<typeof moneySchema>

export function money(amountMinor: number, currency: Currency): Money {
  return { amountMinor, currency }
}

/**
 * Bentuk desimal yang diterima.
 *
 * Pemisah ribuan diizinkan karena supplier memang mengirimkannya: `Number()`
 * atas "1,250.00" menghasilkan NaN, dan itulah jebakan yang ditanam di ZEPH.
 * Bentuk yang tidak cocok TIDAK dipaksa menjadi angka — ia menjadi kegagalan
 * yang terlihat, bukan harga yang salah.
 */
const DECIMAL = /^(-?)(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d+))?$/

/**
 * Mengubah harga desimal supplier menjadi satuan terkecil.
 *
 * Dihitung dengan operasi string, bukan aritmetika pecahan.
 * `Math.round(Number('267.83') * 100)` kebetulan benar untuk banyak nilai dan
 * meleset satu sen untuk sebagian lainnya; yang meleset tidak akan terlihat
 * sampai ada yang mencocokkan tagihan.
 *
 * Mengembalikan undefined bila bentuknya tidak sah, atau bila pemotongan
 * pecahan akan membuang angka bukan nol — supplier yang mengirim tiga desimal
 * untuk USD sedang menyatakan sesuatu yang tidak dapat diwakili, dan diam-diam
 * membulatkannya berarti menagih pengguna dengan angka yang tidak pernah
 * disebutkan siapa pun.
 */
export function parseDecimalAmount(value: string, currency: Currency): number | undefined {
  const match = DECIMAL.exec(value.trim())
  if (match === null) return undefined

  const [, sign = '', whole = '', fraction = ''] = match
  const exponent = EXPONENT[currency]

  if (fraction.length > exponent && /[1-9]/.test(fraction.slice(exponent))) return undefined

  const digits = `${whole.replaceAll(',', '')}${fraction.slice(0, exponent).padEnd(exponent, '0')}`
  const amount = Number(digits)

  return Number.isSafeInteger(amount) ? (sign === '-' ? -amount : amount) : undefined
}

/** Kebalikannya, untuk menyusun permintaan ke supplier yang memakai desimal. */
export function formatDecimalAmount(amount: Money): string {
  const exponent = EXPONENT[amount.currency]
  if (exponent === 0) return String(amount.amountMinor)

  const sign = amount.amountMinor < 0 ? '-' : ''
  const digits = String(Math.abs(amount.amountMinor)).padStart(exponent + 1, '0')

  return `${sign}${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`
}
