'use client'

import { AlertTriangle, CheckCircle2, Clock, FileText, Search, Undo2 } from 'lucide-react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useState } from 'react'
import { EmptyState, ErrorState, LoadingState } from '@/components/state/states'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { startPayment } from '@/features/booking/api'
import { readBookingLabel } from '@/features/booking/session-store'
import { bookingStatusHref } from '@/features/booking/selection'
import { RETURN_PARAM } from '@/features/booking/snap'
import type { StreamMode } from '@/features/booking/status-stream'
import { outcomeOf, stagesOf, type Outcome } from '@/features/booking/timeline'
import type { Booking, BookingStatusView } from '@/features/booking/types'
import { useBookingStatus } from '@/features/booking/use-booking-status'
import { openPayment } from '@/features/booking/use-booking-flow'
import { ApiError, humanMessage } from '@/lib/api-error'
import { cn } from '@/lib/cn'
import { CancellationSection } from '@/components/bookings/cancellation-section'
import { ReviewContact } from '@/components/bookings/review-contact'
import { VoucherDownload } from '@/components/bookings/voucher-download'
import { BookingStatusTimeline } from './booking-status-timeline'
import { StaySummary } from './stay-summary'

/**
 * Halaman status dan konfirmasi pemesanan (FR-23, FR-24, FR-26, US-03).
 *
 * Satu halaman untuk keduanya: pengguna yang menunggu konfirmasi melihat
 * tahapannya bergerak, lalu halaman yang SAMA menjadi konfirmasi begitu
 * supplier menjawab — tanpa dimuat ulang, tanpa berpindah.
 *
 * Parameter `bayar` dari popup atau Snap penuh hanya MENYAPA pengguna sesuai
 * yang baru dialaminya. Ia tidak pernah menentukan apa pun: status di bawahnya
 * dibaca dari server.
 */
export function BookingStatusPage({ bookingId }: { readonly bookingId: string }) {
  const params = useSearchParams()
  const returned = params.get('bayar')
  const state = useBookingStatus(bookingId)
  const { status, booking } = state

  if (state.sessionExpired) {
    return (
      <Shell>
        <ErrorState
          icon={<AlertTriangle />}
          title="Sesimu sudah berakhir"
          description="Masuk kembali untuk melihat status pemesanan ini. Pemesananmu tidak terpengaruh."
          action={
            <Button asChild variant="primary">
              <Link href={`/masuk?lanjut=${encodeURIComponent(bookingStatusHref(bookingId))}`}>
                Masuk
              </Link>
            </Button>
          }
        />
      </Shell>
    )
  }

  if (isNotFound(state.bookingError)) {
    return (
      <Shell>
        <EmptyState
          icon={<Search />}
          title="Pemesanan tidak ditemukan"
          description="Pemesanan ini tidak ada, atau milik akun lain."
          action={
            <Button asChild variant="primary">
              <Link href="/bookings">Lihat pemesananku</Link>
            </Button>
          }
        />
      </Shell>
    )
  }

  if (status === undefined) {
    return (
      <Shell>
        <StatusSkeleton />
      </Shell>
    )
  }

  const outcome = outcomeOf(status)

  return (
    <Shell>
      <OutcomeHeader outcome={outcome} status={status} returned={returned} />

      {status.status === 'HELD' ? <PayAgain bookingId={bookingId} /> : null}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
        <div className="flex min-w-0 flex-col gap-8">
          {status.status === 'CONFIRMED' ? (
            <Confirmation bookingId={bookingId} status={status} />
          ) : null}

          {status.status === 'NEEDS_REVIEW' ? <ReviewContact bookingId={bookingId} /> : null}

          <section aria-labelledby="tahapan" className="flex flex-col gap-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="tahapan" className="text-h3 font-medium">
                Tahapan
              </h2>
              <ConnectionNote mode={state.mode} isFinal={status.isFinal} />
            </div>
            <BookingStatusTimeline stages={stagesOf(status)} />
          </section>
        </div>

        <aside className="flex flex-col gap-8 rounded-lg border border-border bg-card p-5">
          <Summary
            bookingId={bookingId}
            booking={booking}
            isLoading={state.isBookingLoading}
            error={state.bookingError}
            onRetry={state.refetchBooking}
          />
          {status.status === 'CONFIRMED' ? (
            <div className="border-t border-border pt-6">
              <CancellationSection bookingId={bookingId} />
            </div>
          ) : null}
        </aside>
      </div>

      <div className="flex flex-wrap gap-3">
        <Button asChild variant="secondary">
          <Link href="/bookings">Lihat pemesananku</Link>
        </Button>
        <Button asChild variant="ghost">
          <Link href="/cari">Cari penginapan lain</Link>
        </Button>
      </div>
    </Shell>
  )
}

/**
 * Judul dan kalimat keadaan. Diumumkan pembaca layar setiap kali berubah —
 * inilah perubahan status yang ditunggu pengguna dan tidak selalu terlihat.
 */
function OutcomeHeader({
  outcome,
  status,
  returned,
}: {
  readonly outcome: Outcome
  readonly status: BookingStatusView
  readonly returned: string | null
}) {
  const greeting = greetingFor(returned, status)

  return (
    <header className="flex flex-col gap-4">
      {greeting === undefined ? null : (
        <Alert>
          <AlertDescription>{greeting}</AlertDescription>
        </Alert>
      )}
      <div role="status" aria-live="polite" className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className={cn(
            'mt-1 flex size-9 shrink-0 items-center justify-center rounded-full [&_svg]:size-5',
            outcome.tone === 'success' ? 'bg-success/15 text-success' : 'bg-muted text-foreground',
          )}
        >
          {TONE_ICON[outcome.tone]}
        </span>
        <div className="flex max-w-prose flex-col gap-2">
          <h1 className="font-display text-h1">{outcome.title}</h1>
          <p className="text-body text-muted-foreground">{outcome.body}</p>
          {outcome.money === undefined ? null : (
            <p className="text-body font-medium text-foreground">{outcome.money}</p>
          )}
        </div>
      </div>
    </header>
  )
}

const TONE_ICON: Readonly<Record<Outcome['tone'], React.ReactNode>> = {
  success: <CheckCircle2 />,
  waiting: <Clock />,
  refund: <Undo2 />,
  review: <FileText />,
  ended: <Clock />,
}

/**
 * Sapaan untuk pengguna yang baru kembali dari halaman bayar. Hanya bila
 * statusnya belum menjawab sendiri — "pembayaran ditutup" di atas pemesanan
 * yang sudah terkonfirmasi membingungkan.
 */
function greetingFor(returned: string | null, status: BookingStatusView): string | undefined {
  if (status.status !== 'HELD') return undefined

  switch (returned) {
    case RETURN_PARAM.success:
    case RETURN_PARAM.pending:
      return 'Terima kasih. Kami menunggu kabar pembayaranmu dari penyedia pembayaran.'
    case RETURN_PARAM.error:
      return 'Pembayaran tidak berhasil di penyedia pembayaran. Belum ada yang ditagih, dan kamarmu masih ditahan.'
    case RETURN_PARAM.closed:
      return 'Jendela pembayaran ditutup sebelum selesai. Belum ada yang ditagih, dan kamarmu masih ditahan.'
    default:
      return undefined
  }
}

/** Pembayaran yang belum selesai dapat dibuka lagi dari sini — tidak ada jalan buntu. */
function PayAgain({ bookingId }: { readonly bookingId: string }) {
  const router = useRouter()
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<string>()

  function handleClick(): void {
    setOpening(true)
    setError(undefined)
    void startPayment(bookingId)
      .then(async (payment) => await openPayment(payment, bookingId))
      .then((outcome) => {
        if (outcome !== 'redirected') {
          router.replace(bookingStatusHref(bookingId, RETURN_PARAM[outcome]))
        }
      })
      .catch((cause: unknown) => {
        setError(payAgainMessage(cause))
      })
      .finally(() => {
        setOpening(false)
      })
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <Button variant="primary" onClick={handleClick} disabled={opening}>
        {opening ? 'Membuka pembayaran…' : 'Buka pembayaran lagi'}
      </Button>
      <p role="alert" className="text-small text-destructive empty:hidden">
        {error}
      </p>
    </div>
  )
}

function payAgainMessage(cause: unknown): string {
  if (cause instanceof ApiError && cause.code === 'HOLD_EXPIRED') {
    return 'Waktu penahanan kamar sudah habis. Belum ada yang ditagih.'
  }
  if (cause instanceof ApiError && cause.code === 'ALREADY_PAID') {
    return 'Pembayaranmu sudah diterima — statusnya akan muncul sebentar lagi.'
  }
  return humanMessage(cause)
}

/** Konfirmasi (FR-24): kode pemesanan supplier ditampilkan menonjol. */
function Confirmation({
  bookingId,
  status,
}: {
  readonly bookingId: string
  readonly status: BookingStatusView
}) {
  return (
    <section
      aria-labelledby="kode-pemesanan"
      className="flex flex-col gap-4 rounded-lg border border-border bg-card p-5"
    >
      <div className="flex flex-col gap-1">
        <h2
          id="kode-pemesanan"
          className="text-caption uppercase tracking-wide text-muted-foreground"
        >
          Kode pemesanan
        </h2>
        <p className="font-display text-display tabular-nums break-all">{status.supplierRef}</p>
        <p className="text-small text-muted-foreground">
          Tunjukkan kode ini saat check-in. Kode ini juga ada di voucher.
        </p>
      </div>
      <div className="border-t border-border pt-4">
        <VoucherDownload bookingId={bookingId} />
      </div>
    </section>
  )
}

const MODE_NOTE: Readonly<Record<StreamMode, string>> = {
  connecting: 'Menyambungkan…',
  live: 'Diperbarui otomatis',
  reconnecting: 'Menyambung ulang…',
  polling: 'Diperbarui setiap beberapa detik',
  ended: '',
}

function ConnectionNote({
  mode,
  isFinal,
}: {
  readonly mode: StreamMode
  readonly isFinal: boolean
}) {
  return (
    <p className="text-caption text-muted-foreground empty:hidden">
      {isFinal ? '' : MODE_NOTE[mode]}
    </p>
  )
}

function Summary({
  bookingId,
  booking,
  isLoading,
  error,
  onRetry,
}: {
  readonly bookingId: string
  readonly booking: Booking | undefined
  readonly isLoading: boolean
  readonly error: unknown
  readonly onRetry: () => void
}) {
  if (booking === undefined) {
    return isLoading ? (
      <LoadingState label="Memuat rincian pemesanan">
        <Skeleton className="h-48 w-full" />
      </LoadingState>
    ) : (
      <ErrorState
        icon={<AlertTriangle />}
        title="Rincian belum dapat dimuat"
        description={humanMessage(error)}
        action={
          <Button variant="secondary" onClick={onRetry}>
            Coba lagi
          </Button>
        }
      />
    )
  }

  const label = readBookingLabel(bookingId)

  return (
    <StaySummary
      propertyName={booking.propertyName ?? label?.propertyName ?? `Penginapan di ${booking.city}`}
      roomName={booking.terms?.roomTypeName ?? label?.roomName}
      ratePlanName={booking.terms?.ratePlanName}
      city={booking.city}
      checkIn={booking.checkIn}
      checkOut={booking.checkOut}
      guests={booking.guests}
      price={{
        lines: booking.price.lineItems.map((item) => ({
          label: item.description,
          amount: item.amount,
        })),
        total: booking.price.total,
      }}
    />
  )
}

function StatusSkeleton() {
  return (
    <LoadingState label="Memuat status pemesanan" className="flex flex-col gap-6">
      <Skeleton className="h-10 w-80 max-w-full" />
      <Skeleton className="h-5 w-96 max-w-full" />
      <div className="flex flex-col gap-4">
        {[0, 1, 2, 3].map((index) => (
          <Skeleton key={index} className="h-6 w-60" />
        ))}
      </div>
    </LoadingState>
  )
}

function Shell({ children }: { readonly children: React.ReactNode }) {
  return (
    <div className="mx-auto flex max-w-content flex-col gap-8 px-4 py-8 sm:px-6">{children}</div>
  )
}

function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404
}
