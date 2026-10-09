import type { Money } from '@tbe/money'
import { err, ok } from '@tbe/shared-kernel'
import type { Booking, SupplierCode } from '../domain/booking.js'
import type { BookingCommand } from '../domain/commands.js'
import { createBooking } from '../domain/create-booking.js'
import type { BookingError } from '../domain/errors.js'
import { guestDetails } from '../domain/guest-details.js'
import { parseIdempotencyKey } from '../domain/idempotency-key.js'
import { offerTerms, type CancellationPolicy, type OfferTermsInput } from '../domain/offer-terms.js'
import { priceBreakdown } from '../domain/price.js'
import { stayDates } from '../domain/stay-dates.js'
import { quoteLive } from './live-quote.js'
import { loadOwned, persist } from './persist.js'
import type { BookingDeps } from './ports.js'

/**
 * Price check (FR-13, FR-14, US-02).
 *
 * Permintaan pertama dengan sebuah kunci idempotensi MEMBUAT pemesanan lalu
 * memverifikasi harganya. Permintaan berikutnya dengan kunci yang sama tidak
 * membuat pemesanan kedua (FR-18) — ia memverifikasi ULANG harga pemesanan
 * yang sama, karena price check tidak pernah dijawab dari hasil sebelumnya.
 */

export interface PriceCheckRequest {
  readonly userId: string
  readonly idempotencyKey: string
  readonly supplier: SupplierCode
  readonly propertyId: string
  readonly city: string
  readonly ratePlanRef: string
  /** Ketentuan tawaran yang dilihat pengguna — bahan e-voucher (Step 23). */
  readonly offer: OfferTermsInput
  readonly checkIn: string
  readonly checkOut: string
  readonly guest: { readonly fullName: string; readonly email: string; readonly count: number }
  /** Harga jual yang DILIHAT pengguna di hasil pencarian. */
  readonly displayedTotal: Money
}

export type PriceCheckResult =
  /** Keadaan pemesanan menjelaskan hasilnya — lihat price-check-view.ts. */
  | { readonly kind: 'checked'; readonly booking: Booking }
  /** Supplier atau pricing-service belum menjawab. Pemesanan tidak berubah. */
  | { readonly kind: 'retry_later'; readonly booking: Booking }
  | { readonly kind: 'invalid'; readonly reason: string }
  /** Kunci idempotensi yang sama dipakai untuk pemesanan yang berbeda. */
  | { readonly kind: 'key_reused'; readonly booking: Booking }
  | { readonly kind: 'refused'; readonly error: BookingError }
  | { readonly kind: 'not_found' }

export async function startPriceCheck(
  deps: BookingDeps,
  request: PriceCheckRequest,
): Promise<PriceCheckResult> {
  const draft = draftFor(deps, request)
  if (!draft.ok) return { kind: 'invalid', reason: draft.error }

  const created = await deps.bookings.create(draft.value)
  if (created.kind === 'created') return await checkPrice(deps, draft.value.booking)

  // Kunci yang sama untuk isi yang berbeda bukan pengulangan, melainkan
  // kesalahan klien. Mengembalikan pemesanan pertama diam-diam membuat
  // pengguna mengira sudah memesan kamar yang lain.
  if (!isSameRequest(created.existing, draft.value.booking)) {
    return { kind: 'key_reused', booking: created.existing }
  }

  return await checkPrice(deps, created.existing)
}

/**
 * Persetujuan harga baru (FR-14), lalu price check ULANG.
 *
 * Step 17: harga dapat berubah lagi di antara persetujuan dan pembayaran.
 * Persetujuan memindahkan harga yang disetujui, tetapi domain menolak hold
 * sampai harga itu diverifikasi ulang — dan verifikasi ulang itu dijalankan di
 * sini, dalam permintaan yang sama, supaya pengguna langsung tahu apakah
 * harga yang baru disetujuinya masih berlaku.
 */
export async function acceptPriceChange(
  deps: BookingDeps,
  request: { readonly userId: string; readonly bookingId: string },
): Promise<PriceCheckResult> {
  const booking = await loadOwned(deps, request.userId, request.bookingId)
  if (booking === undefined) return { kind: 'not_found' }

  // Persetujuan yang diulang: sudah tersimpan, price check ulangnya yang belum
  // berhasil. Yang tersisa hanyalah price check itu — menolak pengulangan
  // menjebak pengguna yang jawabannya hilang atau dijawab 503 (Step 22).
  if (booking.status === 'PRICE_CHECKED' && booking.priceCheck.kind === 'accepted') {
    return await checkPrice(deps, booking)
  }

  const accepted = await persist(deps, booking, { type: 'acceptPrice', at: deps.clock.now() })
  if (!accepted.ok) return { kind: 'refused', error: accepted.error }

  return await checkPrice(deps, accepted.value.booking)
}

/**
 * Satu price check langsung terhadap pemesanan yang sudah ada.
 *
 * Pemesanan yang tidak dapat diverifikasi harganya — sudah tertahan, sudah
 * dibayar, sudah batal, atau menunggu persetujuan — dikembalikan apa adanya
 * TANPA memanggil supplier. Keadaannya sendiri yang menjelaskan kepada
 * pemanggil kenapa tidak ada price check baru.
 */
export async function checkPrice(deps: BookingDeps, booking: Booking): Promise<PriceCheckResult> {
  if (!isCheckable(booking)) return { kind: 'checked', booking }

  const quote = await quoteLive(deps, booking)
  const at = deps.clock.now()

  switch (quote.kind) {
    case 'unreachable':
    case 'unpriced':
      return { kind: 'retry_later', booking }
    case 'rejected':
      // Kamar habis atau rate plan hilang di supplier: jawaban yang tidak akan
      // berubah dengan dicoba lagi. Pemesanan berakhir, bukan menggantung.
      return await apply(deps, booking, { type: 'cancel', at, reason: 'supplier_rejected' })
    case 'quoted':
      warnIfPolicyDiffers(deps, booking, quote.policy)
      return await apply(deps, booking, {
        type: 'verifyPrice',
        at,
        verified: quote.price,
        policy: quote.policy,
      })
  }
}

/**
 * Kebijakan yang dikirim peramban berbeda dari jawaban supplier (Step 25).
 *
 * Yang dipakai selalu jawaban supplier — itu sudah diputuskan domain. Yang
 * dicatat di sini adalah perbedaannya: hasil pencarian yang basi atau adapter
 * yang salah membaca kebijakan akan terlihat sebagai perbedaan yang berulang,
 * dan pemanggil API yang mencoba menulis kebijakannya sendiri juga.
 */
function warnIfPolicyDiffers(
  deps: BookingDeps,
  booking: Booking,
  verified: CancellationPolicy,
): void {
  const offered = booking.terms?.cancellationPolicy
  if (offered === undefined || isSamePolicy(offered, verified)) return

  deps.logger.warn(
    { bookingId: booking.id, offered, verified },
    'kebijakan pembatalan dari peramban berbeda dari jawaban supplier, yang dipakai milik supplier',
  )
}

function isSamePolicy(a: CancellationPolicy, b: CancellationPolicy): boolean {
  if (!a.refundable || !b.refundable) return a.refundable === b.refundable

  return a.freeCancellationDays === b.freeCancellationDays
}

/** Yang menentukan "pemesanan yang sama": apa yang dipesan, bukan harganya. */
function isSameRequest(existing: Booking, requested: Booking): boolean {
  return (
    existing.supplier === requested.supplier &&
    existing.propertyId === requested.propertyId &&
    existing.ratePlanRef === requested.ratePlanRef &&
    existing.stay.checkIn === requested.stay.checkIn &&
    existing.stay.checkOut === requested.stay.checkOut &&
    existing.guests.count === requested.guests.count
  )
}

function isCheckable(booking: Booking): boolean {
  if (booking.status === 'DRAFT') return true

  return booking.status === 'PRICE_CHECKED' && booking.priceCheck.kind !== 'changed'
}

async function apply(
  deps: BookingDeps,
  booking: Booking,
  command: BookingCommand,
): Promise<PriceCheckResult> {
  const result = await persist(deps, booking, command)

  // `isCheckable` hanya meloloskan keadaan tempat `verifyPrice` dan `cancel`
  // sah menurut tabel transisi. Penolakan di sini berarti keduanya tidak lagi
  // sepakat — cacat program, bukan jawaban untuk pengguna. Versi pertama
  // mengembalikannya sebagai `refused`, dan cakupan uji memperlihatkan cabang
  // itu tidak pernah dapat tercapai.
  if (!result.ok) throw result.error

  return { kind: 'checked', booking: result.value.booking }
}

function draftFor(deps: BookingDeps, request: PriceCheckRequest) {
  const key = parseIdempotencyKey(request.idempotencyKey)
  if (key === undefined) return err('kunci idempotensi tidak sah')

  const stay = stayDates(request)
  if (!stay.ok) return err(`tanggal menginap tidak sah: ${stay.error.kind}`)

  const guests = guestDetails(request.guest)
  if (!guests.ok) return err(`data tamu tidak sah: ${guests.error.kind}`)

  const terms = offerTerms(request.offer)
  if (!terms.ok) return err(`ketentuan tawaran tidak sah: ${terms.error.kind}`)

  // Harga awal adalah harga yang DITAMPILKAN — satu baris, karena hasil
  // pencarian hanya membawa totalnya. Rinciannya menyusul dari price check.
  const price = priceBreakdown([
    { kind: 'room_night', description: 'Harga yang ditampilkan', amount: request.displayedTotal },
  ])
  if (!price.ok) return err(`harga yang ditampilkan tidak sah: ${price.error.kind}`)

  const created = createBooking({
    id: deps.ids.next(),
    userId: request.userId,
    supplier: request.supplier,
    propertyId: request.propertyId,
    city: request.city,
    ratePlanRef: request.ratePlanRef,
    terms: terms.value,
    stay: stay.value,
    guests: guests.value,
    price: price.value,
    idempotencyKey: key,
    at: deps.clock.now(),
  })

  return created.ok ? ok(created.value) : err(created.error.message)
}
