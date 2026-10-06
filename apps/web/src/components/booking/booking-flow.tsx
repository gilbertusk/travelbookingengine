'use client'

import { AlertTriangle, ArrowLeft, BedDouble, CalendarX, ShieldCheck } from 'lucide-react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useMemo } from 'react'
import { EmptyState, ErrorState, LoadingState } from '@/components/state/states'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import type { FlowStep } from '@/features/booking/flow'
import { findOffer, parseSelection, type Selection } from '@/features/booking/selection'
import { rememberBookingLabel } from '@/features/booking/session-store'
import type { Booking } from '@/features/booking/types'
import { useBookingFlow, type BookingFlow } from '@/features/booking/use-booking-flow'
import { nightsBetween, searchHref, toQueryString } from '@/features/search/criteria'
import type { Offer, SearchProperty } from '@/features/search/types'
import { useProperty } from '@/features/search/use-search'
import { humanMessage } from '@/lib/api-error'
import { GuestForm } from './guest-form'
import { HoldCountdown } from './hold-countdown'
import { formatMoney, RateChangeDialog } from './rate-change-dialog'
import { StaySummary, type StayPrice } from './stay-summary'

/**
 * Halaman pemesanan (FR-13 sampai FR-19).
 *
 * Tata letak: ringkasan menginap di kanan pada layar lebar dan di atas pada
 * mobile — terlihat di setiap langkah. Aksi utama menempel di bawah layar
 * pada mobile (DESIGN-SYSTEM.md bagian 10), dan aksen hanya dipakai olehnya.
 */

const GUEST_FORM_ID = 'guest-form'

export function BookingFlowPage() {
  const params = useSearchParams()
  const selection = useMemo(() => parseSelection(new URLSearchParams(params.toString())), [params])

  if (selection === undefined) {
    return (
      <Shell>
        <EmptyState
          icon={<BedDouble />}
          title="Pilih kamar lebih dulu"
          description="Pemesanan dimulai dari halaman properti, setelah kamu memilih tanggal dan kamarnya."
          action={
            <Button asChild variant="primary">
              <Link href="/cari">Cari penginapan</Link>
            </Button>
          }
        />
      </Shell>
    )
  }

  return <WithProperty selection={selection} />
}

function WithProperty({ selection }: { readonly selection: Selection }) {
  const { data, isLoading, error, refetch } = useProperty(selection.slug, selection.criteria)

  if (data === undefined) {
    return (
      <Shell>
        {isLoading ? (
          <FlowSkeleton />
        ) : (
          <ErrorState
            icon={<AlertTriangle />}
            title="Kamar pilihanmu belum dapat dimuat"
            description={humanMessage(error)}
            action={
              <Button
                variant="secondary"
                onClick={() => {
                  void refetch()
                }}
              >
                Coba lagi
              </Button>
            }
          />
        )}
      </Shell>
    )
  }

  const offer = findOffer(data.property.offers, selection)
  // Tawaran yang hilang dari pencarian hanya menghentikan pemesanan BARU.
  // Pemesanan yang sudah dibuat tetap dilanjutkan dengan harganya sendiri.
  if (offer === undefined && selection.bookingId === undefined) {
    return (
      <Shell>
        <EmptyState
          icon={<BedDouble />}
          title="Tarif ini sudah tidak ditawarkan"
          description="Penyedia tidak lagi menawarkan kamar ini untuk tanggalmu. Pilihan lain di properti yang sama mungkin masih tersedia."
          action={
            <Button asChild variant="primary">
              <Link href={propertyHref(selection)}>Lihat kamar lain</Link>
            </Button>
          }
        />
      </Shell>
    )
  }

  return <Flow selection={selection} property={data.property} offer={offer} />
}

function Flow({
  selection,
  property,
  offer,
}: {
  readonly selection: Selection
  readonly property: SearchProperty
  readonly offer: Offer | undefined
}) {
  const router = useRouter()
  const flow = useBookingFlow(selection, offer)
  const { step, booking } = flow
  const bookingId = booking?.id

  // Nama yang sudah dilihat pengguna, untuk halaman status (lihat session-store.ts).
  useEffect(() => {
    if (bookingId === undefined) return
    rememberBookingLabel(bookingId, { propertyName: property.name, roomName: offer?.roomTypeName })
  }, [bookingId, offer?.roomTypeName, property.name])
  const nights = nightsBetween(selection.criteria.checkIn, selection.criteria.checkOut)

  return (
    <Shell>
      <Button
        variant="ghost"
        size="sm"
        className="self-start"
        onClick={() => {
          router.push(propertyHref(selection))
        }}
      >
        <ArrowLeft />
        Kembali ke {property.name}
      </Button>

      <h1 className="font-display text-h1">Selesaikan pemesanan</h1>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
        <aside className="order-first rounded-lg border border-border bg-card p-5 lg:sticky lg:top-24 lg:order-last">
          <StaySummary
            propertyName={property.name}
            roomName={offer?.roomTypeName}
            ratePlanName={offer?.ratePlanName}
            city={property.city}
            checkIn={selection.criteria.checkIn}
            checkOut={selection.criteria.checkOut}
            guests={selection.criteria.guests}
            price={priceOf(booking, offer, nights)}
          />
        </aside>

        <div className="flex min-w-0 flex-col gap-6">
          <StepBody flow={flow} selection={selection} />
        </div>
      </div>

      {step.step === 'rate_changed' ? (
        <>
          <RateChangeDialog
            // Kunci berganti bila harga berubah LAGI setelah disetujui: dialog
            // dirender ulang dengan angka baru, fokus kembali ke awal.
            key={`${String(step.current.amountMinor)}-${step.booking.id}`}
            open={flow.rateDialogOpen}
            previous={step.previous}
            current={step.current}
            difference={step.difference}
            accepting={flow.accepting}
            onAccept={flow.acceptNewPrice}
            onBack={() => {
              router.push(searchHref(selection.criteria))
            }}
            onOpenChange={flow.setRateDialogOpen}
          />
        </>
      ) : null}
    </Shell>
  )
}

function StepBody({
  flow,
  selection,
}: {
  readonly flow: BookingFlow
  readonly selection: Selection
}) {
  const { step } = flow

  switch (step.step) {
    case 'details':
    case 'working':
      return <DetailsStep flow={flow} step={step} />
    case 'rate_changed':
      return (
        <>
          <Alert>
            <AlertDescription>
              Harga kamar diperbarui penyedia menjadi {formatMoney(step.current)}. Pemesanan
              menunggu persetujuanmu.
            </AlertDescription>
          </Alert>
          <StickyAction>
            <Button
              variant="primary"
              className="w-full sm:w-auto"
              onClick={() => {
                flow.setRateDialogOpen(true)
              }}
            >
              Tinjau harga baru
            </Button>
          </StickyAction>
        </>
      )
    case 'held':
      return <HeldStep flow={flow} booking={step.booking} />
    case 'paid':
      return (
        <LoadingState label="Membuka status pemesanan">
          <Skeleton className="h-24 w-full rounded-lg" />
        </LoadingState>
      )
    case 'expired':
      return (
        <EmptyState
          icon={<CalendarX />}
          title="Waktu penahanan kamar habis"
          description="Kamar sudah dilepas supaya tamu lain dapat memesannya. Belum ada yang ditagih — kamu dapat memilihnya lagi bila masih tersedia."
          action={
            <Button asChild variant="primary">
              <Link href={propertyHref(selection)}>Pilih kamar lagi</Link>
            </Button>
          }
        />
      )
    case 'unavailable':
      return (
        <EmptyState
          icon={<BedDouble />}
          title={
            step.reason === 'sold_out'
              ? 'Kamar ini baru saja habis'
              : 'Tarif ini sudah tidak tersedia'
          }
          description="Penyedia tidak dapat menyediakan kamar ini untuk tanggalmu. Belum ada yang ditagih."
          action={
            <Button asChild variant="primary">
              <Link href={propertyHref(selection)}>Lihat kamar lain</Link>
            </Button>
          }
        />
      )
    case 'failed':
      return (
        <>
          {/* Kamar masih tertahan selama pembayaran dicoba lagi; waktunya
              tetap terlihat, bukan hilang bersama layar sebelumnya. */}
          {step.retry === 'pay' && flow.booking?.heldUntil ? (
            <HoldCountdown
              heldUntil={flow.booking.heldUntil}
              offsetMs={flow.offsetMs}
              onExpire={flow.expire}
            />
          ) : null}
          <ErrorState
            icon={<AlertTriangle />}
            title="Langkah ini belum berhasil"
            description={step.message}
            action={
              <div className="flex flex-wrap justify-center gap-3">
                <Button variant="primary" onClick={flow.retry}>
                  Coba lagi
                </Button>
                <Button asChild variant="secondary">
                  <Link href={propertyHref(selection)}>Kembali ke properti</Link>
                </Button>
              </div>
            }
          />
        </>
      )
  }
}

function DetailsStep({
  flow,
  step,
}: {
  readonly flow: BookingFlow
  readonly step: Extract<FlowStep, { step: 'details' | 'working' }>
}) {
  const working = step.step === 'working'

  return (
    <>
      <GuestForm formId={GUEST_FORM_ID} onSubmit={flow.submitGuest} disabled={working} />

      <p className="flex items-start gap-2 text-small text-muted-foreground">
        <ShieldCheck aria-hidden="true" className="mt-1 size-4 shrink-0" />
        Harga diperiksa langsung ke penyedia sebelum kamu membayar. Bila berubah, kamu akan diminta
        menyetujuinya lebih dulu.
      </p>

      <StickyAction>
        <p
          role="status"
          aria-live="polite"
          className="text-small text-muted-foreground empty:hidden"
        >
          {working ? step.label : ''}
        </p>
        <Button
          type="submit"
          form={GUEST_FORM_ID}
          variant="primary"
          className="w-full sm:w-auto"
          disabled={working}
        >
          {working ? 'Memproses…' : 'Lanjutkan ke pembayaran'}
        </Button>
      </StickyAction>
    </>
  )
}

function HeldStep({ flow, booking }: { readonly flow: BookingFlow; readonly booking: Booking }) {
  const heldUntil = booking.heldUntil

  return (
    <>
      {heldUntil === null ? null : (
        <HoldCountdown heldUntil={heldUntil} offsetMs={flow.offsetMs} onExpire={flow.expire} />
      )}

      <div className="flex flex-col gap-2">
        <h2 className="text-h3 font-medium">Pembayaran</h2>
        <p className="max-w-prose text-small text-muted-foreground">
          Kamu akan membayar di jendela Midtrans. Belum ada yang ditagih sampai pembayaran di sana
          selesai, dan status pemesananmu tampil di halaman berikutnya.
        </p>
      </div>

      {flow.paymentClosed ? (
        <Alert>
          <AlertDescription>
            Jendela pembayaran ditutup sebelum selesai. Kamar masih ditahan — kamu dapat membukanya
            lagi.
          </AlertDescription>
        </Alert>
      ) : null}

      <StickyAction>
        <Button
          variant="primary"
          className="w-full sm:w-auto"
          onClick={flow.pay}
          disabled={flow.paying}
        >
          {flow.paying ? 'Membuka pembayaran…' : `Bayar ${formatMoney(booking.price.total)}`}
        </Button>
      </StickyAction>
    </>
  )
}

/**
 * Aksi utama. Menempel di bawah layar di mobile, sebaris dengan isi di layar
 * lebar. Ruang di bawah halaman disisakan Shell supaya tidak menutupi isi.
 */
function StickyAction({ children }: { readonly children: React.ReactNode }) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-10 flex flex-col gap-2 border-t border-border bg-card p-4 sm:static sm:z-auto sm:items-start sm:border-0 sm:bg-transparent sm:p-0">
      {children}
    </div>
  )
}

function Shell({ children }: { readonly children: React.ReactNode }) {
  return (
    <div className="mx-auto flex max-w-content flex-col gap-6 px-4 py-8 pb-32 sm:px-6 sm:pb-12">
      {children}
    </div>
  )
}

function FlowSkeleton() {
  return (
    <LoadingState
      label="Memuat kamar pilihanmu"
      className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px]"
    >
      <div className="flex flex-col gap-4">
        <Skeleton className="h-8 w-64 max-w-full" />
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-11 w-full" />
      </div>
      <Skeleton className="order-first h-64 w-full rounded-lg lg:order-last" />
    </LoadingState>
  )
}

/**
 * Harga di ringkasan: dari pemesanan begitu ada — harga yang DISETUJUI, yang
 * kelak ditagih — dan dari tawaran pencarian sebelum itu.
 */
function priceOf(
  booking: Booking | undefined,
  offer: Offer | undefined,
  nights: number,
): StayPrice | undefined {
  if (booking !== undefined) {
    return {
      lines: booking.price.lineItems.map((item) => ({
        label: item.description,
        amount: item.amount,
      })),
      total: booking.price.total,
    }
  }

  // Pemesanan yang sedang dimuat ulang dan tawarannya sudah hilang dari
  // pencarian: harganya menyusul bersama pemesanan.
  if (offer === undefined) return undefined

  return {
    lines: [
      {
        label: `Harga kamar · ${String(nights)} malam`,
        amount: { ...offer.base, amountMinor: offer.base.amountMinor + offer.markup.amountMinor },
      },
      { label: offer.taxName, amount: offer.tax },
    ],
    total: offer.total,
  }
}

function propertyHref(selection: Selection): string {
  return `/properti/${encodeURIComponent(selection.slug)}?${toQueryString(selection.criteria)}`
}
