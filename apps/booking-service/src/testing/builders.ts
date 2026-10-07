import { money, type Money } from '@tbe/money'
import type { Booking, BookingIn, BookingStatus } from '../domain/booking.js'
import type { BookingCommand, CommandOf, CommandType } from '../domain/commands.js'
import { createBooking } from '../domain/create-booking.js'
import type { BookingChange } from '../domain/events.js'
import { guestDetails, type GuestDetails } from '../domain/guest-details.js'
import { parseIdempotencyKey, type IdempotencyKey } from '../domain/idempotency-key.js'
import { priceBreakdown, type PriceBreakdown } from '../domain/price.js'
import { stayDates, type StayDates } from '../domain/stay-dates.js'
import type { OfferTerms } from '../domain/offer-terms.js'
import { applyCommand } from '../domain/transitions.js'

/**
 * Pembangun pemesanan untuk uji.
 *
 * Setiap keadaan dicapai lewat transisi SUNGGUHAN dari DRAFT, bukan dengan
 * menyusun objek literal. Literal akan menghasilkan pemesanan yang tidak pernah
 * dapat dibuat oleh sistem — dan uji terhadap keadaan yang mustahil adalah uji
 * yang membuktikan hal yang tidak ada.
 */

export const BOOKING_ID = '3f0c8a52-6d1e-4c3b-9a7f-0e1d2c3b4a59'
export const USER_ID = '7b9e2d14-1f3a-4e5c-8d6b-2a1c0f9e8d7c'
export const PAYMENT_ID = 'c2d4e6f8-0a1b-4c3d-8e5f-6a7b8c9d0e1f'
export const REFUND_ID = 'e1f2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a5b'

/** 1 Oktober 2026 pukul 10:00 WIB. */
export const T0 = new Date('2026-10-01T03:00:00.000Z')
export const HOLD_MS = 15 * 60 * 1_000

export function minutesAfter(base: Date, minutes: number): Date {
  return new Date(base.getTime() + minutes * 60_000)
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(`persiapan uji gagal: ${String(result.error)}`)

  return result.value
}

export function idr(amountMinor: number): Money {
  return money(amountMinor, 'IDR')
}

/** Dua malam Rp 1.000.000 ditambah pajak Rp 220.000: total Rp 2.220.000. */
export function samplePrice(nightly = 1_000_000): PriceBreakdown {
  return unwrap(
    priceBreakdown([
      { kind: 'room_night', description: 'Malam 10 Nov 2026', amount: idr(nightly) },
      { kind: 'room_night', description: 'Malam 11 Nov 2026', amount: idr(nightly) },
      { kind: 'tax', description: 'PPN 11%', amount: idr((nightly * 2 * 11) / 100) },
    ]),
  )
}

export function sampleStay(): StayDates {
  return unwrap(stayDates({ checkIn: '2026-11-10', checkOut: '2026-11-12' }))
}

export function sampleGuests(): GuestDetails {
  return unwrap(guestDetails({ fullName: 'Sari Wulandari', email: 'sari@example.com', count: 2 }))
}

export function sampleKey(suffix = 'a'): IdempotencyKey {
  const key = parseIdempotencyKey(`req-2026-10-01-000${suffix}`)
  if (key === undefined) throw new Error('kunci idempotensi contoh tidak sah')

  return key
}

/** Ketentuan tawaran contoh — bahan e-voucher (Step 23). */
export const SAMPLE_TERMS: OfferTerms = {
  roomTypeName: 'Deluxe King',
  ratePlanName: 'Termasuk sarapan',
  breakfastIncluded: true,
  cancellationPolicy: { refundable: true, freeCancellationDays: 3 },
}

export function draftChange(
  overrides: { id?: string; key?: IdempotencyKey; userId?: string } = {},
): BookingChange<BookingIn<'DRAFT'>> {
  return unwrap(
    createBooking({
      id: overrides.id ?? BOOKING_ID,
      userId: overrides.userId ?? USER_ID,
      supplier: 'SKY',
      propertyId: 'prop-bali-001',
      city: 'Denpasar',
      ratePlanRef: 'SKY:RP-DLX-BB',
      terms: SAMPLE_TERMS,
      stay: sampleStay(),
      guests: sampleGuests(),
      price: samplePrice(),
      idempotencyKey: overrides.key ?? sampleKey(),
      at: T0,
    }),
  )
}

export function draft(): BookingIn<'DRAFT'> {
  return draftChange().booking
}

/**
 * Perintah SAH untuk pemesanan pada keadaannya sekarang: nilai yang cocok,
 * batas waktu yang masuk akal, rujukan yang tidak kosong. Dipakai uji tabel
 * untuk membuktikan bahwa setiap sel yang tercantum benar-benar berhasil —
 * kegagalan di sana berarti tabel dan aturan handler tidak sepakat.
 */
export function validCommand<C extends CommandType>(booking: Booking, type: C): CommandOf<C> {
  const at = minutesAfter(booking.updatedAt, 1)
  const commands: { readonly [K in CommandType]: CommandOf<K> } = {
    verifyPrice: { type: 'verifyPrice', at, verified: booking.price },
    acceptPrice: { type: 'acceptPrice', at },
    hold: {
      type: 'hold',
      at,
      holdRef: 'sky-hold-001',
      heldUntil: new Date(at.getTime() + HOLD_MS),
    },
    expireHold: {
      type: 'expireHold',
      at: booking.heldUntil === undefined ? at : minutesAfter(booking.heldUntil, 1),
    },
    recordPayment: {
      type: 'recordPayment',
      at,
      paymentId: PAYMENT_ID,
      amount: booking.price.total,
    },
    confirm: { type: 'confirm', at, supplierRef: 'SKY-BK-778812' },
    fail: { type: 'fail', at, reason: 'supplier menolak konfirmasi setelah tiga percobaan' },
    recordRefund: { type: 'recordRefund', at, refundId: REFUND_ID, amount: booking.price.total },
    cancel: { type: 'cancel', at, reason: 'user_request' },
    requireReview: { type: 'requireReview', at, reason: 'status supplier tidak dapat dipastikan' },
  }

  return commands[type]
}

export function step(booking: Booking, command: BookingCommand): Booking {
  return unwrap(applyCommand(booking, command)).booking
}

function via(booking: Booking, ...types: readonly CommandType[]): Booking {
  return types.reduce((current, type) => step(current, validCommand(current, type)), booking)
}

/** Satu pemesanan contoh pada setiap keadaan, dicapai lewat jalur terpendeknya. */
export function inState(status: BookingStatus): Booking {
  const paths: Readonly<Record<BookingStatus, readonly CommandType[]>> = {
    DRAFT: [],
    PRICE_CHECKED: ['verifyPrice'],
    HELD: ['verifyPrice', 'hold'],
    PAID: ['verifyPrice', 'hold', 'recordPayment'],
    CONFIRMED: ['verifyPrice', 'hold', 'recordPayment', 'confirm'],
    FAILED: ['verifyPrice', 'hold', 'recordPayment', 'fail'],
    REFUNDED: ['verifyPrice', 'hold', 'recordPayment', 'fail', 'recordRefund'],
    CANCELLED: ['cancel'],
    EXPIRED: ['verifyPrice', 'hold', 'expireHold'],
    NEEDS_REVIEW: ['verifyPrice', 'hold', 'recordPayment', 'requireReview'],
  }

  const booking = via(draft(), ...paths[status])
  if (booking.status !== status) throw new Error(`jalur ke ${status} berakhir di ${booking.status}`)

  return booking
}

/** PRICE_CHECKED dengan harga supplier yang berubah dan menunggu persetujuan. */
export function priceChanged(nightly = 1_100_000): BookingIn<'PRICE_CHECKED'> {
  const booking = draft()
  const changed = step(booking, {
    type: 'verifyPrice',
    at: minutesAfter(booking.updatedAt, 1),
    verified: samplePrice(nightly),
  })

  return narrow(changed, 'PRICE_CHECKED')
}

/**
 * Contoh pada keadaan `status` yang sesuai untuk perintah `command`.
 *
 * Hampir selalu sama dengan [inState]. Pengecualiannya satu, dan ia sendiri
 * temuan: `acceptPrice` sah pada PRICE_CHECKED menurut tabel, tetapi hanya
 * BERHASIL dari sub-keadaan `changed`. Sel tabel menyatakan perintah itu
 * bermakna pada keadaan ini; aturan handler menyatakan kapan datanya cocok.
 */
export function sampleFor(status: BookingStatus, command: CommandType): Booking {
  if (status === 'PRICE_CHECKED' && command === 'acceptPrice') return priceChanged()

  return inState(status)
}

export function narrow<S extends BookingStatus>(booking: Booking, status: S): BookingIn<S> {
  if (booking.status !== status)
    throw new Error(`diharapkan ${status}, diperoleh ${booking.status}`)

  // Sudah dipersempit oleh pemeriksaan di atas; TypeScript tidak dapat
  // menghubungkan `status` generik dengan anggota union-nya.
  return booking as BookingIn<S>
}
