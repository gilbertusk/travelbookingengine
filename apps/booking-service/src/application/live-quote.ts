import type { Money } from '@tbe/money'
import type { Booking } from '../domain/booking.js'
import type { PriceBreakdown } from '../domain/price.js'
import { sellPriceBreakdown } from '../domain/sell-price.js'
import { nights } from '../domain/stay-dates.js'
import type { BookingDeps } from './ports.js'

/**
 * Harga jual terkini sebuah pemesanan, langsung dari supplier.
 *
 * **Tidak ada cache di jalur ini, dan tidak ada port untuknya.** FR-13 menuntut
 * price check langsung ke supplier; booking-service bahkan tidak punya
 * dependensi yang dapat menyajikan harga lama. Uji di price-check.test.ts
 * membuktikan setiap price check menghasilkan tepat satu panggilan ke supplier,
 * termasuk yang diulang untuk pemesanan yang sama dalam detik yang sama.
 *
 * Harga supplier lalu dihitung ulang menjadi harga jual lewat pricing-service,
 * karena yang disetujui pengguna adalah harga jual — lihat domain/sell-price.ts.
 */
export type LiveQuote =
  | { readonly kind: 'quoted'; readonly price: PriceBreakdown; readonly supplierTotal: Money }
  | { readonly kind: 'rejected'; readonly reason: 'sold_out' | 'not_found' }
  | { readonly kind: 'unreachable' }
  | { readonly kind: 'unpriced' }

export async function quoteLive(deps: BookingDeps, booking: Booking): Promise<LiveQuote> {
  const answer = await deps.suppliers.priceCheck(ratePlanStayOf(booking))

  if (answer.kind !== 'ok') return answer

  return await priceForSale(deps, booking, answer.value.total)
}

/**
 * Harga supplier menjadi harga jual. Dipakai price check dan hold: supplier
 * mengembalikan totalnya lagi saat hold, dan total itu harus dihitung dengan
 * cara yang sama sebelum dibandingkan dengan harga yang disetujui.
 */
export async function priceForSale(
  deps: BookingDeps,
  booking: Booking,
  supplierTotal: Money,
): Promise<LiveQuote> {
  const quote = await deps.pricing.sellPrice({
    ref: booking.id,
    supplier: booking.supplier,
    city: booking.city,
    supplierTotal,
  })

  if (quote === undefined) return { kind: 'unpriced' }

  const price = sellPriceBreakdown(quote, nights(booking.stay))
  if (!price.ok) {
    // pricing-service menjawab, tetapi jawabannya tidak dapat dipercaya.
    // Tingkat error: tanpa perbaikan di pricing-service, tidak satu pun
    // pemesanan dapat melewati price check.
    deps.logger.error(
      { bookingId: booking.id, reason: price.error.kind },
      'harga jual dari pricing-service tidak konsisten',
    )
    return { kind: 'unpriced' }
  }

  return { kind: 'quoted', price: price.value, supplierTotal }
}

export function ratePlanStayOf(booking: Booking) {
  return {
    supplier: booking.supplier,
    // Rujukan rate plan disimpan apa adanya dari hasil pencarian, dan itulah
    // pengenal versi supplier yang dipakai price check dan hold.
    supplierRatePlanId: booking.ratePlanRef,
    checkIn: booking.stay.checkIn,
    checkOut: booking.stay.checkOut,
  }
}
