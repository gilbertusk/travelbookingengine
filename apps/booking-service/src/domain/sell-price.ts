import { add, isNegative, type Money } from '@tbe/money'
import { err, ok, type Result } from '@tbe/shared-kernel'
import { isSameAmount, priceBreakdown, type PriceBreakdown } from './price.js'

/**
 * Harga jual: harga supplier setelah markup dan pajak (FR-05).
 *
 * Price check supplier mengembalikan harga SUPPLIER. Harga yang dilihat dan
 * disetujui pengguna adalah harga JUAL dari pricing-service. Membandingkan
 * keduanya langsung akan melaporkan "harga berubah" pada setiap pemesanan —
 * selisihnya persis markup dan pajak. Karena itu setiap harga supplier yang
 * diverifikasi dihitung ulang menjadi harga jual lebih dulu, dengan aturan yang
 * sama dengan pencarian, dan baru harga jual itu yang dibandingkan.
 */

export interface SellQuote {
  readonly base: Money
  readonly markup: Money
  readonly tax: Money
  readonly total: Money
  /** Nama pajak untuk e-voucher, mis. "PPN 11%". */
  readonly taxName: string
}

export type SellPriceError =
  | { readonly kind: 'mixed_currency' }
  | { readonly kind: 'negative_component' }
  | { readonly kind: 'inconsistent_total' }
  | { readonly kind: 'zero_total' }

/**
 * Rincian harga dari hasil pricing-service.
 *
 * Satu baris kamar (harga supplier + markup) dan satu baris pajak. Markup
 * TIDAK ditampilkan sebagai baris sendiri: pengguna membeli kamar, bukan
 * markup, dan PRD tidak pernah meminta margin ditunjukkan.
 *
 * Total dari pricing-service tidak dipercaya begitu saja: baris-barisnya harus
 * menjumlah tepat ke total itu. pricing-service membulatkan sekali di akhir
 * (CONVENTIONS.md bagian 9), jadi selisih satu rupiah pun berarti komponen dan
 * totalnya dihitung dengan aturan berbeda — dan yang ditagih akan berbeda dari
 * yang tertulis di e-voucher.
 */
export function sellPriceBreakdown(
  quote: SellQuote,
  nights: number,
): Result<PriceBreakdown, SellPriceError> {
  const parts = [quote.base, quote.markup, quote.tax, quote.total]
  if (parts.some((part) => part.currency !== quote.total.currency)) {
    return err({ kind: 'mixed_currency' })
  }
  if (parts.some(isNegative)) return err({ kind: 'negative_component' })

  const room = add(quote.base, quote.markup)
  const lines = [
    { kind: 'room_night' as const, description: `Kamar, ${String(nights)} malam`, amount: room },
    { kind: 'tax' as const, description: quote.taxName, amount: quote.tax },
  ]

  // Mata uang campuran dan nilai negatif sudah ditolak di atas, dan baris
  // kamar selalu ada — satu-satunya alasan tersisa priceBreakdown menolak
  // adalah total nol. Dilaporkan dengan namanya sendiri, bukan disamarkan
  // sebagai "tidak konsisten".
  const built = priceBreakdown(lines)
  if (!built.ok) return err({ kind: 'zero_total' })
  if (!isSameAmount(built.value.total, quote.total)) return err({ kind: 'inconsistent_total' })

  return ok(built.value)
}
