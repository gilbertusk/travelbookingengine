import type { SupplierCode } from './supplier.js'

/**
 * Hold dan booking di sisi supplier.
 *
 * Dua sifat yang wajib benar karena Step 11, 19, dan 22 bersandar padanya:
 * hold yang kedaluwarsa mengembalikan unitnya tanpa perlu diminta, dan book
 * bersifat idempoten terhadap idempotency key. Tanpa yang kedua, percobaan
 * ulang setelah timeout menghasilkan pemesanan ganda — kerugian uang nyata
 * yang tidak akan pernah terlihat pada pengujian yang tidak menyentuh kondisi
 * balapan.
 */

export const DEFAULT_HOLD_TTL_MS = 15 * 60 * 1_000

export interface Hold {
  readonly ref: string
  readonly supplier: SupplierCode
  readonly ratePlanId: string
  readonly checkIn: string
  readonly checkOut: string
  readonly guests: number
  readonly priceMinorIdr: number
  readonly expiresAtMs: number
  readonly createdAtMs: number
}

export type BookingStatus = 'CONFIRMED' | 'CANCELLED'

export interface Booking {
  readonly ref: string
  readonly supplier: SupplierCode
  readonly holdRef: string
  readonly ratePlanId: string
  readonly checkIn: string
  readonly checkOut: string
  readonly guests: number
  readonly guestName: string
  readonly amountMinorIdr: number
  readonly status: BookingStatus
  readonly idempotencyKey: string
  readonly createdAtMs: number
  readonly cancelledAtMs?: number
}

export function isHoldExpired(hold: Hold, nowMs: number): boolean {
  return hold.expiresAtMs <= nowMs
}

export function cancelBooking(booking: Booking, nowMs: number): Booking {
  return { ...booking, status: 'CANCELLED', cancelledAtMs: nowMs }
}

export type OperationFailure =
  | { readonly kind: 'invalid_request'; readonly reason: string }
  | { readonly kind: 'not_found'; readonly what: string }
  | { readonly kind: 'sold_out' }
  | { readonly kind: 'hold_expired' }
  | { readonly kind: 'price_changed'; readonly newPriceMinorIdr: number }
  | { readonly kind: 'already_cancelled' }
