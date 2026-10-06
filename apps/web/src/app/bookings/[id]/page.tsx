import { Suspense } from 'react'
import type { Metadata } from 'next'
import { BookingStatusPage } from '@/components/booking/booking-status-page'

export const metadata: Metadata = { title: 'Status pemesanan' }

/** Status dan konfirmasi pemesanan (FR-23, FR-24, FR-26). */
export default async function BookingStatusRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  return (
    <Suspense fallback={null}>
      <BookingStatusPage bookingId={id} />
    </Suspense>
  )
}
