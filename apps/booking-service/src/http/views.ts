import { subtract, toJson, type Money, type MoneyJson } from '@tbe/money'
import type { StatusSnapshot } from '../application/booking-status.js'
import { isFinal, type Booking } from '../domain/booking.js'
import { cancellationView } from './cancellation-views.js'

/**
 * Bentuk pemesanan yang dikirim ke klien.
 *
 * `serverTime` adalah jam booking-service saat respons dibentuk. Klien memakainya
 * untuk menghitung selisih dengan jamnya sendiri, supaya hitung mundur hold
 * mengikuti jam yang menentukan `heldUntil` — bukan jam komputer pengguna yang
 * bisa meleset beberapa menit (Step 21).
 *
 * Tidak menyertakan kunci idempotensi, versi, maupun data tamu. Kunci dan
 * versi adalah urusan internal; data tamu sudah dimiliki klien yang
 * mengirimnya, dan setiap salinan tambahannya di respons adalah salinan
 * tambahan di log proxy mana pun di antaranya (NFR-15).
 */
export function bookingView(booking: Booking, now: Date) {
  return {
    id: booking.id,
    status: booking.status,
    supplier: booking.supplier,
    propertyId: booking.propertyId,
    city: booking.city,
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
    cancellation: cancellationView(booking),
    // Step 26: halaman detail menampilkan bukti pemesanan dan ketentuannya.
    supplierRef: booking.supplierRef ?? null,
    terms: termsView(booking),
    serverTime: now.toISOString(),
  }
}

/**
 * Ketentuan tawaran yang dipesan. Kebijakan pembatalan di sini adalah versi
 * supplier (Step 25), sama dengan yang dicetak voucher. `null` untuk pemesanan
 * sebelum Step 23.
 */
function termsView(booking: Booking) {
  const terms = booking.terms
  if (terms === undefined) return null

  return {
    roomTypeName: terms.roomTypeName,
    ratePlanName: terms.ratePlanName,
    breakfastIncluded: terms.breakfastIncluded,
    cancellationPolicy: terms.cancellationPolicy,
  }
}

/**
 * Satu entri daftar pemesanan (Step 26). Status dibawa sebagai kodenya;
 * kalimatnya milik klien, yang juga menyusun kalimat untuk halaman status.
 */
export function listItemView(booking: Booking, propertyName: string | null) {
  return {
    id: booking.id,
    status: booking.status,
    isFinal: isFinal(booking.status),
    propertyName,
    city: booking.city,
    roomTypeName: booking.terms?.roomTypeName ?? null,
    checkIn: booking.stay.checkIn,
    checkOut: booking.stay.checkOut,
    guests: booking.guests.count,
    supplierRef: booking.supplierRef ?? null,
    total: toJson(booking.price.total),
    refund: refundStatus(booking),
    review: reviewConcern(booking),
    cancellation: cancellationView(booking),
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

/**
 * Status pemesanan untuk pengguna yang menunggu (Step 19, dipakai Step 21).
 *
 * Membawa yang dibutuhkan FR-23 — alasan kegagalan dan status pengembalian
 * dananya — tanpa rincian saga yang hanya bermakna bagi operator: fase dan
 * langkahnya disertakan supaya layar tunggu dapat berkata "menunggu
 * konfirmasi supplier", bukan untuk ditafsirkan klien menjadi keputusan.
 */
export function statusView(snapshot: StatusSnapshot, now: Date) {
  const { booking, saga } = snapshot

  return {
    id: booking.id,
    status: booking.status,
    isFinal: isFinal(booking.status),
    version: booking.version,
    updatedAt: booking.updatedAt.toISOString(),
    heldUntil: booking.heldUntil?.toISOString() ?? null,
    supplierRef: booking.supplierRef ?? null,
    failureReason: booking.failure?.reason ?? null,
    refund: refundStatus(booking),
    review: reviewConcern(booking),
    cancellation: cancellationView(booking),
    saga: saga === undefined ? null : { phase: saga.phase, step: saga.step },
    serverTime: now.toISOString(),
  }
}

/**
 * `pending`: refund sudah diminta dan belum dikonfirmasi. `review`: uang
 * pengguna sedang ditangani manusia — refund gagal, atau status supplier tidak
 * pasti dan TIDAK ada refund otomatis (US-05).
 *
 * Pembatalan oleh pengguna (Step 25): `pending` hanya setelah supplier
 * membatalkan dan refund terkirim; sebelum itu belum ada uang yang bergerak.
 * Pembatalan tanpa dana kembali tidak punya status refund sama sekali.
 */
/**
 * Apa yang diperiksa manusia, untuk kalimat yang jujur di layar: kamar yang
 * belum pasti (dari PAID), refund kompensasi (dari FAILED), atau pembatalan
 * oleh pengguna yang tidak tuntas (dari CANCELLING, Step 25).
 */
const REVIEW_CONCERNS = {
  PAID: 'room',
  FAILED: 'refund',
  CANCELLING: 'cancellation',
} as const

function reviewConcern(booking: Booking): 'room' | 'refund' | 'cancellation' | null {
  return booking.review === undefined ? null : REVIEW_CONCERNS[booking.review.from]
}

function refundStatus(booking: Booking): 'pending' | 'completed' | 'review' | null {
  if (booking.status === 'FAILED') return 'pending'
  if (booking.status === 'REFUNDED') return 'completed'
  if (booking.status === 'NEEDS_REVIEW') return 'review'
  if (booking.cancellationStage?.step === 'refund') return 'pending'
  if (booking.cancellationSettlement?.kind === 'refunded') return 'completed'

  return null
}
