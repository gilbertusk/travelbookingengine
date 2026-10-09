import type { Booking, SupplierCode } from '../domain/booking.js'
import type { BookingGroup } from '../domain/booking-groups.js'
import { parseLocalDate } from '../domain/stay-dates.js'
import type { BookingDeps } from './ports.js'

/**
 * Daftar pemesanan pengguna (Step 26, FR-25), satu kelompok per permintaan.
 *
 * Halaman berupa offset yang dibungkus penunjuk buram. Pemesanan yang
 * berpindah kelompok di antara dua halaman — dibatalkan saat pengguna menggulir
 * — dapat terlewat atau terulang satu kali; untuk daftar pribadi yang jarang
 * melewati satu halaman, itu harga yang lebih murah daripada penunjuk
 * berlapis untuk tiga urutan yang berbeda.
 */

export const MAX_PAGE_SIZE = 50

export interface ListedBooking {
  readonly booking: Booking
  /** Nama properti dari katalog. `null` bila katalog tidak menjawab atau tidak mengenalnya. */
  readonly propertyName: string | null
}

export type ListResult =
  | {
      readonly kind: 'page'
      readonly items: readonly ListedBooking[]
      readonly nextCursor: string | null
    }
  | { readonly kind: 'invalid_cursor' }

export interface ListRequest {
  readonly userId: string
  readonly group: BookingGroup
  readonly limit: number
  readonly cursor?: string | undefined
}

export async function listBookings(deps: BookingDeps, request: ListRequest): Promise<ListResult> {
  const offset = request.cursor === undefined ? 0 : offsetOf(request.cursor)
  if (offset === undefined) return { kind: 'invalid_cursor' }

  const limit = Math.min(Math.max(request.limit, 1), MAX_PAGE_SIZE)
  // Satu lebih banyak dari yang diminta: tanpa hitungan terpisah, inilah
  // cara mengetahui ada halaman berikutnya.
  const found = await deps.bookings.findByUser({
    userId: request.userId,
    group: request.group,
    today: todayUtc(deps.clock.now()),
    offset,
    limit: limit + 1,
  })
  const bookings = found.slice(0, limit)
  const names = await propertyNames(deps, bookings)

  return {
    kind: 'page',
    items: bookings.map((booking) => ({
      booking,
      propertyName: names.get(propertyKey(booking.supplier, booking.propertyId)) ?? null,
    })),
    nextCursor: found.length > limit ? String(offset + limit) : null,
  }
}

function offsetOf(cursor: string): number | undefined {
  if (!/^\d{1,9}$/.test(cursor)) return undefined

  return Number(cursor)
}

function todayUtc(now: Date) {
  const today = parseLocalDate(now.toISOString().slice(0, 10))
  if (today === undefined) throw new Error(`jam sistem di luar jangkauan: ${now.toISOString()}`)

  return today
}

function propertyKey(supplier: SupplierCode, propertyId: string): string {
  return `${supplier}/${propertyId}`
}

/**
 * Nama properti, sekali per properti dan bersamaan. Katalog yang tidak
 * menjawab tidak menggagalkan daftar — entri tetap tampil dengan kotanya.
 */
async function propertyNames(
  deps: BookingDeps,
  bookings: readonly Booking[],
): Promise<ReadonlyMap<string, string>> {
  const unique = new Map(
    bookings.map((booking) => [propertyKey(booking.supplier, booking.propertyId), booking]),
  )
  const answers = await Promise.all(
    [...unique.entries()].map(async ([key, booking]) => {
      const answer = await deps.properties.lookup(booking.supplier, booking.propertyId)
      return answer.kind === 'found' ? ([key, answer.name] as const) : undefined
    }),
  )

  return new Map(answers.filter((entry) => entry !== undefined))
}
