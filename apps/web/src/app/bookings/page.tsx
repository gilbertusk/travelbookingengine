import type { Metadata } from 'next'
import { BookingsList } from '@/components/bookings/bookings-list'

export const metadata: Metadata = { title: 'Pemesananku' }

/**
 * Daftar pemesanan (Step 26, FR-25).
 *
 * Rute privat: middleware mengalihkan pengunjung tanpa sesi ke halaman masuk
 * sebelum halaman ini sempat dirender.
 */
export default function BookingsPage() {
  return (
    <div className="mx-auto flex max-w-detail flex-col gap-8 px-4 py-12 sm:px-6">
      <h1 className="font-display text-h1">Pemesananku</h1>
      <BookingsList />
    </div>
  )
}
