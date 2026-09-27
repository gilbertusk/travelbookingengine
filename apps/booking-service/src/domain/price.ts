import { equals, isNegative, isZero, sum, type Currency, type Money } from '@tbe/money'
import { err, ok, type Result } from '@tbe/shared-kernel'

/**
 * Rincian harga sebuah pemesanan.
 *
 * Total TIDAK disimpan terpisah dari rinciannya dan tidak dapat diberikan dari
 * luar: satu-satunya jalan memperoleh [PriceBreakdown] adalah [priceBreakdown],
 * yang menjumlahkan barisnya sendiri. Dengan begitu tidak ada pemesanan yang
 * totalnya berbeda dari jumlah barisnya — keadaan yang di sistem lain ditemukan
 * pengguna di e-voucher, bukan oleh uji.
 *
 * Seluruh nilai memakai @tbe/money. Tidak ada `number` telanjang untuk uang
 * (NFR-08), dan tidak ada total tanpa mata uang.
 */

export const LINE_ITEM_KINDS = ['room_night', 'tax', 'fee'] as const
export type LineItemKind = (typeof LINE_ITEM_KINDS)[number]

export interface BookingLineItem {
  readonly kind: LineItemKind
  /** Keterangan untuk e-voucher, mis. "Malam 10 Nov 2026" atau "PPN 11%". */
  readonly description: string
  readonly amount: Money
}

declare const priceBreakdownBrand: unique symbol

/**
 * Bermerek, jadi literal `{ total, lineItems }` dari mana pun tidak diterima
 * sebagai rincian harga. Tanpa merek, klaim "satu-satunya jalan" di atas hanya
 * kesepakatan — dan pembaca baris basis data adalah tempat pertama yang akan
 * melanggarnya dengan menyusun total dari kolomnya sendiri.
 */
export interface PriceBreakdown {
  readonly total: Money
  readonly lineItems: readonly BookingLineItem[]
  readonly [priceBreakdownBrand]: true
}

export type PriceBreakdownError =
  | { readonly kind: 'no_room_night' }
  | { readonly kind: 'mixed_currency' }
  | { readonly kind: 'negative_line_item'; readonly index: number }
  | { readonly kind: 'zero_total' }

export function priceBreakdown(
  lineItems: readonly BookingLineItem[],
): Result<PriceBreakdown, PriceBreakdownError> {
  // Rincian tanpa satu malam pun bukan harga kamar. Pemeriksaan ini sekaligus
  // menjamin daftarnya tidak kosong, jadi baris pertama pasti ada di bawah.
  const [first] = lineItems.filter((item) => item.kind === 'room_night')
  if (first === undefined) return err({ kind: 'no_room_night' })

  const currency: Currency = first.amount.currency
  if (lineItems.some((item) => item.amount.currency !== currency)) {
    return err({ kind: 'mixed_currency' })
  }

  // Potongan harga tidak dimodelkan sebagai baris negatif. Baris negatif
  // membuat "total = jumlah baris" tetap benar sambil menyembunyikan dari mana
  // selisihnya berasal, dan MVP tidak punya potongan harga sama sekali.
  const negative = lineItems.findIndex((item) => isNegative(item.amount))
  if (negative !== -1) return err({ kind: 'negative_line_item', index: negative })

  const total = sum(
    lineItems.map((item) => item.amount),
    currency,
  )
  if (isZero(total)) return err({ kind: 'zero_total' })

  // Salinan, supaya pemanggil yang kemudian mengubah larik miliknya tidak ikut
  // mengubah rincian yang totalnya sudah dihitung.
  const items: readonly BookingLineItem[] = [...lineItems]

  // Merek dilekatkan hanya di sini, setelah seluruh aturan di atas terbukti.
  return ok({ total, lineItems: items } as PriceBreakdown)
}

/**
 * Kesamaan dua nilai uang tanpa melempar.
 *
 * `equals` dari @tbe/money melempar untuk mata uang berbeda, dan itu benar untuk
 * perhitungan. Di sini mata uang yang berbeda adalah JAWABAN — harga supplier
 * yang tiba-tiba dalam USD adalah perubahan harga, dan pembayaran dalam mata
 * uang lain adalah pembayaran yang tidak cocok — bukan cacat program.
 */
export function isSameAmount(a: Money, b: Money): boolean {
  return a.currency === b.currency && equals(a, b)
}
