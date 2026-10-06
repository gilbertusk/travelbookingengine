import { Suspense } from 'react'
import type { Metadata } from 'next'
import { BookingFlowPage } from '@/components/booking/booking-flow'

export const metadata: Metadata = { title: 'Selesaikan pemesanan' }

/**
 * Alur pemesanan (Step 21). Rute privat lewat awalan /bookings: pengunjung
 * tanpa sesi dialihkan ke halaman masuk BESERTA pilihan kamarnya di kueri.
 */
export default function BookingFlowRoute() {
  return (
    <Suspense fallback={null}>
      <BookingFlowPage />
    </Suspense>
  )
}
