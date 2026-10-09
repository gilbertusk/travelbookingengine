'use client'

import { FileText } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { fetchVoucherLink } from '@/features/bookings/api'
import { ApiError, humanMessage } from '@/lib/api-error'

/**
 * Unduh e-voucher (FR-24, Step 26).
 *
 * Tautannya bertanda tangan dan berumur lima menit, jadi diminta saat tombol
 * ditekan — bukan saat halaman dimuat. Tautan yang dimuat lebih dulu sudah
 * kedaluwarsa bagi pengguna yang membiarkan tab terbuka.
 */
export function VoucherDownload({ bookingId }: { readonly bookingId: string }) {
  const [opening, setOpening] = useState(false)
  const [message, setMessage] = useState<string>()

  function handleClick(): void {
    setOpening(true)
    setMessage(undefined)
    void fetchVoucherLink(bookingId)
      .then((url) => {
        window.location.assign(url)
      })
      .catch((cause: unknown) => {
        setMessage(voucherMessage(cause))
      })
      .finally(() => {
        setOpening(false)
      })
  }

  return (
    <div className="flex flex-col gap-1">
      <Button variant="secondary" className="self-start" onClick={handleClick} disabled={opening}>
        <FileText />
        {opening ? 'Membuka voucher…' : 'Unduh voucher'}
      </Button>
      <p role="status" className="text-small text-muted-foreground empty:hidden">
        {message}
      </p>
    </div>
  )
}

function voucherMessage(cause: unknown): string {
  if (cause instanceof ApiError && (cause.status === 404 || cause.status === 409)) {
    return 'Voucher sedang disiapkan. Coba lagi sebentar lagi; salinannya juga dikirim ke surelmu.'
  }

  return humanMessage(cause)
}
