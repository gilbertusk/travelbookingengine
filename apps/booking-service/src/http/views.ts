import { subtract, toJson, type Money, type MoneyJson } from '@tbe/money'
import type { Booking } from '../domain/booking.js'

/**
 * Bentuk pemesanan yang dikirim ke klien.
 *
 * Tidak menyertakan kunci idempotensi, versi, maupun data tamu. Kunci dan
 * versi adalah urusan internal; data tamu sudah dimiliki klien yang
 * mengirimnya, dan setiap salinan tambahannya di respons adalah salinan
 * tambahan di log proxy mana pun di antaranya (NFR-15).
 */
export function bookingView(booking: Booking) {
  return {
    id: booking.id,
    status: booking.status,
    supplier: booking.supplier,
    propertyId: booking.propertyId,
    ratePlanRef: booking.ratePlanRef,
    checkIn: booking.stay.checkIn,
    checkOut: booking.stay.checkOut,
    guests: booking.guests.count,
    price: {
      total: toJson(booking.price.total),
      lineItems: booking.price.lineItems.map((item) => ({
        kind: item.kind,
        description: item.description,
        amount: toJson(item.amount),
      })),
    },
    heldUntil: booking.heldUntil?.toISOString() ?? null,
    priceCheck: priceCheckView(booking),
  }
}

/**
 * Hasil price check, dibaca dari KEADAAN pemesanan — bukan dari jalannya
 * permintaan. Permintaan yang kalah balapan dengan permintaan serentak lain
 * tetap memperoleh jawaban yang benar, karena jawabannya ada di keadaan yang
 * menang.
 *
 * `changed` membawa harga lama, harga baru, dan selisihnya secara eksplisit
 * (US-02). Selisih `null` hanya bila mata uangnya berbeda: selisih antara rupiah
 * dan dolar bukan angka yang bermakna.
 */
export function priceCheckView(booking: Booking) {
  if (booking.status === 'CANCELLED' && booking.cancellation === 'supplier_rejected') {
    return { outcome: 'unavailable' as const }
  }
  if (booking.status !== 'PRICE_CHECKED') return null

  const check = booking.priceCheck
  if (check.kind === 'verified') {
    return { outcome: 'unchanged' as const, price: toJson(booking.price.total) }
  }
  if (check.kind === 'accepted') return { outcome: 'awaiting_recheck' as const }

  return {
    outcome: 'changed' as const,
    previous: toJson(booking.price.total),
    current: toJson(check.quoted.total),
    difference: difference(booking.price.total, check.quoted.total),
  }
}

function difference(previous: Money, current: Money): MoneyJson | null {
  return previous.currency === current.currency ? toJson(subtract(current, previous)) : null
}
