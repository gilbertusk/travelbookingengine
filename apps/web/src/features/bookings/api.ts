import { bookingSchema, type Booking, type Money } from '@/features/booking/types'
import { parse } from '@/features/booking/api'
import { apiRequest } from '@/lib/api-client'
import {
  listPageSchema,
  previewSchema,
  voucherLinkSchema,
  type BookingGroup,
  type BookingListPage,
  type CancellationPreview,
} from './types'

/** Panggilan jaringan daftar pemesanan dan pembatalan (Step 26). */

export const PAGE_SIZE = 10

export async function fetchBookingsPage(
  group: BookingGroup,
  cursor: string | undefined,
  signal?: AbortSignal,
): Promise<BookingListPage> {
  const params = new URLSearchParams({ group, limit: String(PAGE_SIZE) })
  if (cursor !== undefined) params.set('cursor', cursor)

  const data = await apiRequest<unknown>(`/bookings?${params.toString()}`, {
    ...(signal === undefined ? {} : { signal }),
  })
  return parse(listPageSchema, data)
}

export async function fetchCancellationPreview(
  bookingId: string,
  signal?: AbortSignal,
): Promise<CancellationPreview> {
  const data = await apiRequest<unknown>(
    `/bookings/${encodeURIComponent(bookingId)}/cancellation-preview`,
    { ...(signal === undefined ? {} : { signal }) },
  )
  return parse(previewSchema, data)
}

/**
 * Membatalkan dengan nilai yang DILIHAT pengguna. Bila jenjangnya sudah
 * berganti, booking-service menjawab 409 `REFUND_CHANGED` dan tidak ada yang
 * dibatalkan — pemanggil memuat ulang pratinjaunya.
 */
export async function cancelBooking(bookingId: string, expectedRefund: Money): Promise<Booking> {
  const data = await apiRequest<unknown>(`/bookings/${encodeURIComponent(bookingId)}/cancel`, {
    method: 'POST',
    body: { expectedRefund },
  })
  return parse(bookingSchema, data)
}

/** Tautan unduh voucher, bertanda tangan dan berumur pendek. Diminta saat tombol ditekan. */
export async function fetchVoucherLink(bookingId: string): Promise<string> {
  const data = await apiRequest<unknown>(`/vouchers/${encodeURIComponent(bookingId)}`)
  return parse(voucherLinkSchema, data).url
}
