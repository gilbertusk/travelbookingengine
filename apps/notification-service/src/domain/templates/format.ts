import { format, money } from '@tbe/money'
import type { MoneyAmount } from '../notification.js'

/** Pemformatan nilai untuk surel. */

const MONTHS = [
  'Januari',
  'Februari',
  'Maret',
  'April',
  'Mei',
  'Juni',
  'Juli',
  'Agustus',
  'September',
  'Oktober',
  'November',
  'Desember',
] as const

/**
 * `2026-11-10` menjadi `10 November 2026`.
 *
 * Diurai sebagai teks, BUKAN lewat `Date`: tanggal menginap adalah tanggal
 * lokal properti (CONVENTIONS.md bagian 9), dan `new Date('2026-11-10')`
 * adalah tengah malam UTC — yang di zona barat sudah tanggal 9.
 */
export function stayDate(isoDate: string): string {
  const [year, month, day] = isoDate.split('-')
  const name = MONTHS[Number(month) - 1]
  if (year === undefined || day === undefined || name === undefined) return isoDate

  return `${String(Number(day))} ${name} ${year}`
}

const NO_BREAK_SPACE = String.fromCharCode(0xa0)

export function amount(value: MoneyAmount): string {
  // Intl memisahkan simbol dan angka dengan spasi tak-putus; surel teks biasa
  // menampilkannya lebih rapi dengan spasi biasa.
  return format(money(value.amountMinor, value.currency)).replaceAll(NO_BREAK_SPACE, ' ')
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/** Setiap nilai yang masuk HTML lewat sini — nama tamu adalah masukan pengguna. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char)
}
