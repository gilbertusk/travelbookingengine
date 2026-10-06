import { parseCriteria, toQueryString, type SearchCriteria } from '@/features/search/criteria'
import type { Offer } from '@/features/search/types'

/**
 * Pilihan kamar yang dibawa dari halaman properti ke alur pemesanan, lewat URL.
 *
 * URL, bukan state di memori: alur pemesanan berada di balik halaman masuk,
 * dan pengguna yang belum masuk dialihkan lalu dikembalikan ke URL ini —
 * keadaan di memori tidak selamat dari perjalanan itu. Yang dibawa hanyalah
 * PENGENAL tawaran; rinciannya diambil ulang dari pencarian di halaman
 * pemesanan, supaya harga yang ditampilkan bukan harga yang tertulis di URL
 * yang bisa diubah siapa pun.
 */

export interface Selection {
  readonly slug: string
  readonly supplier: string
  readonly ratePlanId: string
  readonly criteria: SearchCriteria
  /** Pemesanan yang sudah dibuat dari pilihan ini — untuk melanjutkan setelah dimuat ulang. */
  readonly bookingId?: string | undefined
}

export const BOOKING_FLOW_PATH = '/bookings/pesan'

export function bookingHref(slug: string, offer: Offer, criteria: SearchCriteria): string {
  const params = new URLSearchParams(toQueryString(criteria))
  params.set('properti', slug)
  params.set('penyedia', offer.supplier)
  params.set('tarif', offer.supplierRatePlanId)

  return `${BOOKING_FLOW_PATH}?${params.toString()}`
}

export function parseSelection(params: URLSearchParams): Selection | undefined {
  const criteria = parseCriteria(params)
  const slug = params.get('properti')
  const supplier = params.get('penyedia')
  const ratePlanId = params.get('tarif')
  if (criteria === undefined || !slug || !supplier || !ratePlanId) return undefined

  const bookingId = params.get('pesanan') ?? undefined

  return { slug, supplier, ratePlanId, criteria, bookingId }
}

/** URL yang sama, ditambah pemesanan yang sudah dibuat. */
export function withBooking(params: URLSearchParams, bookingId: string): string {
  const next = new URLSearchParams(params)
  next.set('pesanan', bookingId)

  return `${BOOKING_FLOW_PATH}?${next.toString()}`
}

/** Satu pilihan kamar untuk satu masa inap — dasar idempotency key-nya. */
export function selectionKey(selection: Selection): string {
  const { criteria } = selection

  return [
    selection.supplier,
    selection.ratePlanId,
    criteria.checkIn,
    criteria.checkOut,
    String(criteria.guests),
  ].join('|')
}

export function findOffer(
  offers: readonly Offer[],
  selection: Pick<Selection, 'supplier' | 'ratePlanId'>,
): Offer | undefined {
  return offers.find(
    (offer) =>
      offer.supplier === selection.supplier && offer.supplierRatePlanId === selection.ratePlanId,
  )
}

export function bookingStatusHref(bookingId: string, payment?: string): string {
  const base = `/bookings/${encodeURIComponent(bookingId)}`

  return payment === undefined ? base : `${base}?bayar=${encodeURIComponent(payment)}`
}
