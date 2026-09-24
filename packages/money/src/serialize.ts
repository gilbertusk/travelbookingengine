import { z } from 'zod'
import { currencySchema, type Currency } from './currency.js'
import { money, type Money } from './money.js'

/**
 * Bentuk uang saat disimpan dan dikirim.
 *
 * Sama persis dengan bentuk di memori: bilangan bulat satuan terkecil dan kode
 * mata uang. Tidak ada serialisasi ke string desimal — string desimal harus
 * diurai kembali, dan penguraian itulah tempat pecahan biner menyelinap masuk.
 */
export const moneySchema = z.object({
  amountMinor: z.number().int(),
  currency: currencySchema,
})

export type MoneyJson = z.infer<typeof moneySchema>

export function toJson(value: Money): MoneyJson {
  return { amountMinor: value.amountMinor, currency: value.currency }
}

/**
 * Mengurai uang dari sumber yang tidak tepercaya.
 *
 * Mengembalikan undefined alih-alih melempar: nilai uang cacat yang datang
 * dari pesan atau respons supplier adalah data yang salah, bukan kerusakan
 * sistem, dan pemanggil yang harus memutuskan apa artinya.
 */
export function fromJson(value: unknown): Money | undefined {
  const parsed = moneySchema.safeParse(value)

  return parsed.success ? money(parsed.data.amountMinor, parsed.data.currency) : undefined
}

/** Melempar bila cacat. Dipakai pada data milik kita sendiri. */
export function parseMoney(value: unknown): Money {
  const parsed = moneySchema.parse(value)

  return money(parsed.amountMinor, parsed.currency)
}

/**
 * Bentuk untuk kolom Prisma.
 *
 * Dua kolom: bilangan bulat dan kode mata uang. TIDAK PERNAH satu kolom
 * `Float` atau `Decimal` — NFR-08. `Float` kehilangan presisi, dan `Decimal`
 * kembali sebagai string atau objek pustaka yang harus diurai lagi di setiap
 * tempat yang membacanya.
 */
export interface MoneyColumns {
  readonly amountMinor: number
  readonly currency: Currency
}

export function toColumns(value: Money, prefix: string): Record<string, number | string> {
  return { [`${prefix}AmountMinor`]: value.amountMinor, [`${prefix}Currency`]: value.currency }
}

export function fromColumns(amountMinor: number, currency: string): Money | undefined {
  return fromJson({ amountMinor, currency })
}
