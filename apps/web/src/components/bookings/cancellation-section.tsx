'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import { useRef, useState } from 'react'
import { formatMoney } from '@/components/booking/rate-change-dialog'
import { ErrorState, LoadingState } from '@/components/state/states'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import type { Money } from '@/features/booking/types'
import { cancelBooking, fetchCancellationPreview } from '@/features/bookings/api'
import { formatDeadline, policyLines } from '@/features/bookings/presentation'
import type { CancellationPreview, RefundQuote } from '@/features/bookings/types'
import { ApiError, humanMessage } from '@/lib/api-error'

/**
 * Kebijakan pembatalan dan alur pembatalan (Step 26, FR-27).
 *
 * Nilai yang kembali terlihat DUA kali sebelum pengguna menekan tombol akhir:
 * di bagian ini, dan di dialog konfirmasi. Tombol pembuka bukan aksi utama
 * halaman; tombol akhirnya bervarian destructive, dan fokus awal dialog jatuh
 * pada "Jangan batalkan" — Enter yang tidak sengaja tidak membatalkan apa pun.
 */

/** Perkiraan sampainya dana, sama dengan yang dijanjikan surel (notification-service). */
export const REFUND_ARRIVAL = '3–14 hari kerja'

export function CancellationSection({ bookingId }: { readonly bookingId: string }) {
  const preview = useQuery({
    queryKey: ['cancellation-preview', bookingId],
    queryFn: async ({ signal }) => await fetchCancellationPreview(bookingId, signal),
  })

  return (
    <section aria-labelledby="kebijakan-pembatalan" className="flex flex-col gap-4">
      <h2 id="kebijakan-pembatalan" className="text-h3 font-medium">
        Kebijakan pembatalan
      </h2>
      <PreviewBody
        bookingId={bookingId}
        preview={preview.data}
        isLoading={preview.isPending}
        error={preview.error}
        onRetry={() => {
          void preview.refetch()
        }}
      />
    </section>
  )
}

function PreviewBody({
  bookingId,
  preview,
  isLoading,
  error,
  onRetry,
}: {
  readonly bookingId: string
  readonly preview: CancellationPreview | undefined
  readonly isLoading: boolean
  readonly error: unknown
  readonly onRetry: () => void
}) {
  if (preview === undefined) {
    return isLoading ? (
      <LoadingState label="Menghitung pengembalian dana">
        <Skeleton className="h-24 w-full" />
      </LoadingState>
    ) : (
      <ErrorState
        icon={<AlertTriangle />}
        title="Kebijakan pembatalan belum dapat dihitung"
        description={humanMessage(error)}
        action={
          <Button variant="secondary" onClick={onRetry}>
            Coba lagi
          </Button>
        }
      />
    )
  }

  if (!preview.cancellable) {
    return <p className="max-w-prose text-body text-muted-foreground">{preview.message}</p>
  }

  return (
    <div className="flex flex-col gap-4">
      <ul className="flex max-w-prose flex-col gap-2 text-body text-foreground">
        {policyLines(preview.quote).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p className="max-w-prose text-body text-foreground">
        <RefundNow quote={preview.quote} />
      </p>
      <CancelDialog bookingId={bookingId} paid={preview.paid} quote={preview.quote} />
    </div>
  )
}

function RefundNow({ quote }: { readonly quote: RefundQuote }) {
  if (quote.refund.amountMinor === 0) {
    return <>Bila dibatalkan sekarang, tidak ada dana yang kembali.</>
  }

  return (
    <>
      Bila dibatalkan sekarang, dana yang kembali{' '}
      <span className="font-semibold tabular-nums">{formatMoney(quote.refund)}</span> (
      {String(quote.percent)}%).
    </>
  )
}

function CancelDialog({
  bookingId,
  paid,
  quote,
}: {
  readonly bookingId: string
  readonly paid: Money
  readonly quote: RefundQuote
}) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string>()
  const keepRef = useRef<HTMLButtonElement>(null)

  function handleConfirm(): void {
    setSending(true)
    setError(undefined)
    void cancelBooking(bookingId, quote.refund)
      .then(async () => {
        setOpen(false)
        await queryClient.invalidateQueries({ queryKey: ['bookings'] })
        await queryClient.invalidateQueries({ queryKey: ['booking', bookingId] })
      })
      .catch(async (cause: unknown) => {
        if (cause instanceof ApiError && cause.code === 'REFUND_CHANGED') {
          // Jenjangnya berganti sejak pratinjau. Tidak ada yang dibatalkan;
          // nilai baru dimuat dan ditampilkan sebelum pengguna memutuskan lagi.
          setError(
            'Nilai pengembalian baru saja berubah. Periksa nilai yang baru sebelum membatalkan.',
          )
          await queryClient.invalidateQueries({ queryKey: ['cancellation-preview', bookingId] })
          return
        }
        setError(humanMessage(cause))
      })
      .finally(() => {
        setSending(false)
      })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="secondary" className="self-start">
          Batalkan pemesanan
        </Button>
      </DialogTrigger>
      <DialogContent
        onOpenAutoFocus={(event) => {
          // Fokus awal pada "Jangan batalkan", bukan tombol yang merusak.
          event.preventDefault()
          keepRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>Batalkan pemesanan ini?</DialogTitle>
          <DialogDescription>
            Kamar akan dibatalkan di penyedia. Pembatalan tidak dapat diurungkan.
          </DialogDescription>
        </DialogHeader>

        <dl className="mt-4 flex flex-col gap-3 text-body">
          <Row term="Dana yang kembali">
            <span className="text-h3 font-semibold tabular-nums">{formatMoney(quote.refund)}</span>
          </Row>
          <Row term="Dana yang hangus">
            <span className="tabular-nums">{formatMoney(forfeited(paid, quote.refund))}</span>
          </Row>
          <Row term="Perkiraan sampai">
            {quote.refund.amountMinor === 0
              ? 'Tidak ada dana yang dikembalikan'
              : `${REFUND_ARRIVAL} setelah penyedia membatalkan kamar`}
          </Row>
        </dl>
        <NothingBackNote quote={quote} />

        <p role="alert" className="mt-4 text-small text-destructive empty:hidden">
          {error}
        </p>

        <DialogFooter>
          <DialogClose asChild>
            <Button ref={keepRef} variant="secondary" disabled={sending}>
              Jangan batalkan
            </Button>
          </DialogClose>
          <Button variant="destructive" onClick={handleConfirm} disabled={sending}>
            {sending ? 'Membatalkan…' : 'Ya, batalkan pemesanan'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function NothingBackNote({ quote }: { readonly quote: RefundQuote }) {
  const reason = quote.nothingBack
  if (reason === null) return null

  const text =
    reason.kind === 'non_refundable'
      ? 'Rate ini sejak awal tidak dapat dikembalikan.'
      : `Tenggat pengembalian ${String(reason.lastRefund.percent)}% berakhir ${formatDeadline(reason.lastRefund.until, quote.timeZone)}.`

  return <p className="mt-3 text-small text-muted-foreground">{text}</p>
}

function Row({ term, children }: { readonly term: string; readonly children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-small text-muted-foreground">{term}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  )
}

function forfeited(paid: Money, refund: Money): Money {
  return { ...paid, amountMinor: paid.amountMinor - refund.amountMinor }
}
