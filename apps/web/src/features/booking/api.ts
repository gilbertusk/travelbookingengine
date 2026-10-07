import type { z } from 'zod'
import { apiRequest } from '@/lib/api-client'
import { ApiError } from '@/lib/api-error'
import {
  bookingSchema,
  paymentStartSchema,
  statusSchema,
  type Booking,
  type BookingStatusView,
  type GuestInput,
  type Money,
  type PaymentStart,
} from './types'

/**
 * Panggilan jaringan alur pemesanan. Seluruhnya lewat api-gateway di awalan
 * `/bookings`, yang mewajibkan sesi.
 */

export interface PriceCheckInput {
  readonly idempotencyKey: string
  readonly supplier: string
  readonly propertyId: string
  readonly city: string
  readonly ratePlanRef: string
  /**
   * Ketentuan tawaran yang dilihat pengguna. booking-service menyalinnya
   * sebagai bahan e-voucher (Step 23); harga tidak termasuk di sini.
   */
  readonly offer: OfferTermsInput
  readonly checkIn: string
  readonly checkOut: string
  readonly guests: number
  readonly guest: GuestInput
  /** Harga yang dilihat pengguna. booking-service membandingkannya, tidak mempercayainya. */
  readonly displayedTotal: Money
}

export interface OfferTermsInput {
  readonly roomTypeName: string
  readonly ratePlanName: string
  readonly breakfastIncluded: boolean
  readonly cancellationPolicy:
    | { readonly refundable: false }
    | { readonly refundable: true; readonly freeCancellationDays?: number }
}

export async function priceCheck(input: PriceCheckInput): Promise<Booking> {
  const data = await apiRequest<unknown>('/bookings/price-check', {
    method: 'POST',
    body: {
      idempotencyKey: input.idempotencyKey,
      supplier: input.supplier,
      propertyId: input.propertyId,
      city: input.city,
      ratePlanRef: input.ratePlanRef,
      offer: input.offer,
      checkIn: input.checkIn,
      checkOut: input.checkOut,
      guest: { ...input.guest, count: input.guests },
      displayedTotal: input.displayedTotal,
    },
  })
  return parse(bookingSchema, data)
}

export async function acceptPrice(bookingId: string): Promise<Booking> {
  const data = await apiRequest<unknown>('/bookings/price-check/accept', {
    method: 'POST',
    body: { bookingId },
  })
  return parse(bookingSchema, data)
}

export async function placeHold(bookingId: string, unitsLeft: number): Promise<Booking> {
  const data = await apiRequest<unknown>('/bookings/hold', {
    method: 'POST',
    body: { bookingId, unitsLeft },
  })
  return parse(bookingSchema, data)
}

export async function fetchBooking(bookingId: string, signal?: AbortSignal): Promise<Booking> {
  const data = await apiRequest<unknown>(`/bookings/${encodeURIComponent(bookingId)}`, {
    ...(signal === undefined ? {} : { signal }),
  })
  return parse(bookingSchema, data)
}

export async function fetchStatus(
  bookingId: string,
  signal?: AbortSignal,
): Promise<BookingStatusView> {
  const data = await apiRequest<unknown>(`/bookings/${encodeURIComponent(bookingId)}/status`, {
    ...(signal === undefined ? {} : { signal }),
  })
  return parse(statusSchema, data)
}

export async function startPayment(bookingId: string): Promise<PaymentStart> {
  const data = await apiRequest<unknown>(`/bookings/${encodeURIComponent(bookingId)}/payment`, {
    method: 'POST',
  })
  return parse(paymentStartSchema, data)
}

/**
 * Jawaban yang bentuknya tidak dikenal menjadi galat server — sama dengan
 * amplop yang tidak dapat diurai di api-client.
 */
export function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data)
  if (parsed.success) return parsed.data

  throw new ApiError({
    kind: 'server',
    status: 200,
    code: 'MALFORMED_RESPONSE',
    message: 'Respons server tidak dalam bentuk yang diharapkan.',
    cause: parsed.error,
  })
}
