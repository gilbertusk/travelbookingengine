import { Suspense } from 'react'
import type { Metadata } from 'next'
import { PaymentReturn } from '@/components/booking/payment-return'

export const metadata: Metadata = { title: 'Kembali dari pembayaran' }

/**
 * Finish URL Snap untuk mode halaman penuh. Midtrans tidak tahu pemesanan
 * kita — order_id-nya pengenal PEMBAYARAN — jadi pemesanannya dibaca dari
 * catatan yang ditinggalkan alur sebelum berpindah ke Snap.
 */
export default function PaymentReturnRoute() {
  return (
    <Suspense fallback={null}>
      <PaymentReturn />
    </Suspense>
  )
}
