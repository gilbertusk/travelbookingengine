'use client'

import { Receipt } from 'lucide-react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useSyncExternalStore } from 'react'
import { EmptyState, LoadingState } from '@/components/state/states'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { bookingStatusHref } from '@/features/booking/selection'
import { sessionStore } from '@/features/booking/session-store'
import { PAYING_KEY, returnParamOf } from '@/features/booking/snap'

/**
 * Kembali dari Snap halaman penuh: meneruskan ke status pemesanan yang tadi
 * dibayar. `transaction_status` dari URL hanya menentukan sapaannya; status
 * pemesanan tetap dibaca dari server di halaman tujuan.
 *
 * Catatan pemesanan tidak ada — tab lain, peramban lain — bukan jalan buntu:
 * daftar pemesanan memuat semuanya.
 */
export function PaymentReturn() {
  const router = useRouter()
  const params = useSearchParams()
  // `undefined` di server (belum diketahui), `null` bila catatannya tidak ada.
  const bookingId = useSyncExternalStore(
    noSubscription,
    () => sessionStore.get(PAYING_KEY) ?? null,
    () => undefined,
  )
  const missing = bookingId === null

  useEffect(() => {
    if (typeof bookingId !== 'string') return
    router.replace(bookingStatusHref(bookingId, returnParamOf(params.get('transaction_status'))))
  }, [bookingId, params, router])

  if (missing) {
    return (
      <div className="mx-auto max-w-detail px-4 py-12 sm:px-6">
        <EmptyState
          icon={<Receipt />}
          title="Kami tidak tahu pemesanan mana yang baru kamu bayar"
          description="Halaman ini dibuka di tab atau peramban yang berbeda dari tempat kamu memesan. Status pembayaranmu tetap tercatat di daftar pemesanan."
          action={
            <Button asChild variant="primary">
              <Link href="/bookings">Lihat pemesananku</Link>
            </Button>
          }
        />
      </div>
    )
  }

  return (
    <LoadingState
      label="Membuka status pemesanan"
      className="mx-auto max-w-detail px-4 py-12 sm:px-6"
    >
      <Skeleton className="h-10 w-72 max-w-full" />
    </LoadingState>
  )
}

/** sessionStorage tidak memberi tahu perubahan di tab yang sama; cukup dibaca sekali. */
function noSubscription(): () => void {
  return () => undefined
}
