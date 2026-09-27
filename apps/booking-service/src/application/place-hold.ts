import type { Booking } from '../domain/booking.js'
import type { BookingError } from '../domain/errors.js'
import { effectiveHoldUntil } from '../domain/hold-window.js'
import { isSameAmount } from '../domain/price.js'
import { applyCommand } from '../domain/transitions.js'
import { priceForSale, ratePlanStayOf } from './live-quote.js'
import { loadOwned, persist } from './persist.js'
import type { BookingDeps, HoldEntry } from './ports.js'

/**
 * Hold (FR-15): lapis lokal, lalu lapis supplier.
 *
 * Urutannya disengaja, dan setiap langkah punya kompensasinya:
 *
 * 1. **Periksa domain lebih dulu, tanpa efek.** Hold untuk pemesanan yang
 *    harganya belum disetujui akan ditolak domain di akhir — setelah hold
 *    lokal dan hold supplier terlanjur diambil. Perintah hold dicoba terhadap
 *    domain dengan nilai sementara; kalau ditolak, tidak ada yang disentuh.
 * 2. **Lokal (Redis).** Murah, atomik, dan menjamin US-04. Supplier tidak
 *    dipanggil sama sekali untuk permintaan yang pasti tidak kebagian.
 * 3. **Supplier.** Bila gagal, hold lokal dilepas.
 * 4. **Harga saat hold.** Supplier mengembalikan totalnya lagi; totalnya
 *    dihitung ulang menjadi harga jual dan dibandingkan dengan harga yang
 *    disetujui. Berbeda berarti harga berubah di antara price check dan hold —
 *    G2 melarang melanjutkan dengan harga yang tidak disetujui.
 * 5. **Simpan.** Batas waktu yang dipakai adalah yang lebih awal antara lokal
 *    dan supplier, dan kunci waktu lokal dimajukan ke sana.
 *
 * Hold di supplier TIDAK dapat dilepaskan — tidak ada operasinya (lihat
 * `SupplierQuotes`). Setiap kompensasi setelah langkah 3 meninggalkan hold
 * supplier yang kedaluwarsa sendiri.
 */

export interface HoldRequest {
  readonly userId: string
  readonly bookingId: string
  /** Ketersediaan yang terlihat di hasil pencarian. */
  readonly unitsLeft: number
}

export type HoldResult =
  | { readonly kind: 'held'; readonly booking: Booking }
  | { readonly kind: 'refused'; readonly error: BookingError }
  | { readonly kind: 'sold_out'; readonly booking: Booking }
  /** Hold untuk pemesanan ini sedang diproses permintaan lain. */
  | { readonly kind: 'in_progress'; readonly booking: Booking }
  | { readonly kind: 'price_changed'; readonly booking: Booking }
  | { readonly kind: 'retry_later'; readonly booking: Booking }
  | { readonly kind: 'not_found' }

export async function placeHold(deps: BookingDeps, request: HoldRequest): Promise<HoldResult> {
  const booking = await loadOwned(deps, request.userId, request.bookingId)
  if (booking === undefined) return { kind: 'not_found' }

  // Pengulangan permintaan yang sudah berhasil: jawab dengan hasilnya.
  if (booking.status === 'HELD') return { kind: 'held', booking }

  const now = deps.clock.now()
  const localUntil = new Date(now.getTime() + deps.holdPolicy.durationMs)

  const dryRun = applyCommand(booking, {
    type: 'hold',
    at: now,
    holdRef: '-',
    heldUntil: localUntil,
  })
  if (!dryRun.ok) return { kind: 'refused', error: dryRun.error }

  const entry = { bookingId: booking.id, slot: slotOf(booking) }
  const local = await deps.holds.acquire({
    ...entry,
    capacity: request.unitsLeft,
    until: localUntil,
  })

  if (local === 'sold_out') return { kind: 'sold_out', booking }
  // Slot sudah dipegang pemesanan ini tetapi pemesanannya belum HELD: ada
  // permintaan lain yang sedang di tengah langkah 3 atau 4. Melanjutkan berarti
  // DUA hold di supplier untuk satu pemesanan, dan salah satunya yatim.
  if (local === 'already_held') return { kind: 'in_progress', booking }

  return await holdAtSupplier(deps, booking, entry, localUntil)
}

async function holdAtSupplier(
  deps: BookingDeps,
  booking: Booking,
  entry: HoldEntry,
  localUntil: Date,
): Promise<HoldResult> {
  const answer = await deps.suppliers.hold({
    ...ratePlanStayOf(booking),
    guests: booking.guests.count,
  })

  if (answer.kind !== 'ok') {
    await deps.holds.release(entry)
    return answer.kind === 'rejected'
      ? { kind: 'sold_out', booking }
      : { kind: 'retry_later', booking }
  }

  const priced = await priceForSale(deps, booking, answer.value.total)
  if (priced.kind !== 'quoted') {
    await deps.holds.release(entry)
    return { kind: 'retry_later', booking }
  }
  if (!isSameAmount(priced.price.total, booking.price.total)) {
    await deps.holds.release(entry)
    return { kind: 'price_changed', booking }
  }

  const heldUntil = effectiveHoldUntil(localUntil, answer.value.expiresAt)
  const at = deps.clock.now()
  const saved = await persist(deps, booking, {
    type: 'hold',
    at,
    holdRef: answer.value.holdRef,
    heldUntil,
  })

  // Pemesanan berpindah oleh pihak lain di antara langkah 1 dan 5 — dibatalkan
  // pengguna, misalnya — atau hold supplier sudah kedaluwarsa saat tiba.
  if (!saved.ok || saved.value.kind === 'superseded') {
    await deps.holds.release(entry)
    return saved.ok
      ? { kind: 'in_progress', booking: saved.value.booking }
      : { kind: 'refused', error: saved.error }
  }

  await deps.holds.shorten(booking.id, heldUntil)

  return { kind: 'held', booking: saved.value.booking }
}

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
