/**
 * Pemformat tampilan panel. Angka dari service datang dalam satuan yang tepat
 * (basis poin, milidetik, satuan uang terkecil); pembulatan untuk mata
 * manusia terjadi HANYA di sini.
 */

const percentFormat = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 1 })
const numberFormat = new Intl.NumberFormat('id-ID')
const dateTimeFormat = new Intl.DateTimeFormat('id-ID', {
  dateStyle: 'medium',
  timeStyle: 'medium',
  timeZone: 'Asia/Jakarta',
})

/** Basis poin → persen. `null` (tidak ada pembagi) ditampilkan "—", bukan "0%". */
export function percent(basisPoints: number | null): string {
  return basisPoints === null ? '—' : `${percentFormat.format(basisPoints / 100)}%`
}

export function milliseconds(value: number | null): string {
  return value === null ? '—' : `${numberFormat.format(value)} ms`
}

export function count(value: number): string {
  return numberFormat.format(value)
}

export interface MoneyJson {
  readonly amountMinor: number
  readonly currency: string
}

/** IDR berpangkat 0; mata uang lain berpangkat 2 (sama dengan @tbe/money). */
export function money(value: MoneyJson): string {
  const exponent = value.currency === 'IDR' ? 0 : 2
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: value.currency,
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  }).format(value.amountMinor / 10 ** exponent)
}

/** Waktu ditampilkan dalam WIB — zona operasional, bukan zona peramban operator. */
export function dateTime(iso: string): string {
  return `${dateTimeFormat.format(new Date(iso))} WIB`
}
