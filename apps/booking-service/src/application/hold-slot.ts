import type { Booking } from '../domain/booking.js'

/**
 * Slot ketersediaan: satu rate plan pada satu rentang tanggal (Step 17).
 *
 * Dua pemesanan untuk rate plan yang sama pada rentang yang TUMPANG TINDIH
 * tetapi tidak sama — 10–12 dan 11–13 November — memakai slot berbeda.
 * Menghitung per malam akan lebih tepat, tetapi butuh ketersediaan per malam
 * dari supplier, dan hasil pencarian hanya memberi satu angka untuk seluruh
 * rentang. Lapis supplier yang menjaga kasus tumpang tindih.
 */
export function slotOf(booking: Booking): string {
  const { supplier, ratePlanRef, stay } = booking

  return `${supplier}|${ratePlanRef}|${stay.checkIn}|${stay.checkOut}`
}
