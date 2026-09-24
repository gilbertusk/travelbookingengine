import { CURRENCIES, EXPONENT, money, type Currency, type Money } from '@tbe/money'

/**
 * Uang, dari `@tbe/money`.
 *
 * Sampai Step 12 berkas ini memuat definisinya sendiri sebagai penampung
 * sementara. Definisi itu sudah digantikan: `Money` sekarang datang dari satu
 * tempat untuk seluruh sistem, dan seluruh aritmetikanya berjalan di sana.
 *
 * Yang tersisa di berkas ini hanya satu hal yang memang milik lapisan adapter:
 * membaca harga desimal yang dikirim supplier. Itu bukan aritmetika uang —
 * itu penguraian format, dan formatnya berbeda pada setiap supplier.
 */

export { CURRENCIES, EXPONENT, money }
export type { Currency, Money }
export { currencySchema, moneySchema, toDecimalString } from '@tbe/money'

/**
 * Bentuk desimal yang diterima dari supplier.
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
