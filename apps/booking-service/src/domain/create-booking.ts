import { err, ok, type Result } from '@tbe/shared-kernel'
import type { DraftBooking, SupplierCode } from './booking.js'
import { BookingRuleError } from './errors.js'
import type { BookingChange } from './events.js'
import type { GuestDetails } from './guest-details.js'
import type { IdempotencyKey } from './idempotency-key.js'
import type { PriceBreakdown } from './price.js'
import type { StayDates } from './stay-dates.js'

/**
 * Pembuatan pemesanan: satu-satunya jalan masuk ke DRAFT.
 *
 * Seluruh masukannya sudah berupa value object yang tervalidasi — tanggal
 * menginap, tamu, rincian harga, kunci idempotensi. Yang tersisa untuk
 * diperiksa di sini hanya rujukan teks yang tidak punya bentuk sendiri.
 *
 * `price` adalah harga yang DITAMPILKAN kepada pengguna saat memesan, dan
 * menjadi harga yang disetujui pertama. `booking.created` membawanya ke
 * payment-service sebagai nilai yang boleh ditagih sampai price check berkata
 * lain.
 */

export interface CreateBookingInput {
  readonly id: string
  readonly userId: string
  readonly supplier: SupplierCode
  readonly propertyId: string
  readonly ratePlanRef: string
  readonly stay: StayDates
  readonly guests: GuestDetails
  readonly price: PriceBreakdown
  readonly idempotencyKey: IdempotencyKey
  readonly at: Date
}

/** Versi pertama. Nomor urut peristiwa pertama di booking_events. */
export const INITIAL_VERSION = 1

export function createBooking(
  input: CreateBookingInput,
): Result<BookingChange<DraftBooking>, BookingRuleError> {
  const blank = (['id', 'userId', 'propertyId', 'ratePlanRef'] as const).find(
    (field) => input[field].trim().length === 0,
  )

  if (blank !== undefined) {
    return err(new BookingRuleError(input.id, 'blank_field', `Bidang ${blank} kosong`))
  }

  const { at, ...fields } = input
  const booking: DraftBooking = {
    ...fields,
    status: 'DRAFT',
    version: INITIAL_VERSION,
    createdAt: at,
    updatedAt: at,
  }

  return ok({
    booking,
    event: {
      type: 'BookingCreated',
      bookingId: booking.id,
      version: booking.version,
      occurredAt: at,
      userId: booking.userId,
      supplier: booking.supplier,
      propertyId: booking.propertyId,
      ratePlanRef: booking.ratePlanRef,
      stay: booking.stay,
      guestCount: booking.guests.count,
      amount: booking.price.total,
    },
  })
}
