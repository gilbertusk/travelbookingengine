'use client'

import { AlertTriangle, ArrowLeft, MapPin, Star } from 'lucide-react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useMemo } from 'react'
import { ErrorState } from '@/components/state/states'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { PropertyPhoto } from '@/components/search/property-photo'
import { amenityLabel, nightsBetween, parseCriteria, searchHref } from '@/features/search/criteria'
import { useProperty } from '@/features/search/use-search'
import { humanMessage } from '@/lib/api-error'
import { AmenityItem, RatePlanRow } from './rate-plan-row'
import type { Offer, SearchProperty } from '@/features/search/types'

/**
 * Halaman detail properti (FR-10, FR-11, FR-12).
 *
 * Kriterianya wajib ada di URL, dan itu bukan kelalaian rancangan: harga
 * hanya bermakna untuk rentang tanggal tertentu. Halaman detail tanpa tanggal
 * harus menanyakannya lebih dulu, bukan menampilkan harga entah untuk kapan.
 *
 * Lebar konten 960px — `max-w-content` dari DESIGN-SYSTEM.md. Pada mobile,
 * aksi utama menempel di bawah layar.
 */

export function PropertyDetail({ slug }: { readonly slug: string }) {
  const router = useRouter()
  const params = useSearchParams()

  const criteria = useMemo(() => parseCriteria(new URLSearchParams(params.toString())), [params])

  const { data, isLoading, error, refetch } = useProperty(slug, criteria)

  if (criteria === undefined) {
    return (
      <Shell>
        <ErrorState
          icon={<AlertTriangle />}
          title="Tanggal menginap belum dipilih"
          description="Harga kamar berbeda menurut tanggalnya, jadi halaman ini membutuhkan tanggal masuk dan keluar."
          action={
            <Button asChild variant="secondary">
              <Link href="/cari">Mulai pencarian</Link>
            </Button>
          }
        />
      </Shell>
    )
  }

  const nights = nightsBetween(criteria.checkIn, criteria.checkOut)

  return (
    <Shell>
      <Button
        variant="ghost"
        size="sm"
        className="self-start"
        onClick={() => {
          router.push(searchHref(criteria))
        }}
      >
        <ArrowLeft />
        Kembali ke hasil
      </Button>

      {data === undefined ? (
        isLoading ? (
          <DetailSkeleton />
        ) : (
          <ErrorState
            icon={<AlertTriangle />}
            title="Properti tidak dapat dimuat"
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
        )
      ) : (
        <Content property={data.property} nights={nights} />
      )}
    </Shell>
  )
}

function Shell({ children }: { readonly children: React.ReactNode }) {
  return (
    <div className="mx-auto flex max-w-content flex-col gap-6 px-4 py-8 pb-24 sm:px-6 lg:pb-8">
      {children}
    </div>
  )
}

function Content({
  property,
  nights,
}: {
  readonly property: SearchProperty
  readonly nights: number
}) {
  const cheapest = lowestOf(property.offers)

  return (
    <>
      <Gallery property={property} />

      <header className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{property.name}</h1>
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <MapPin className="size-4 shrink-0" aria-hidden="true" />
          {property.address ?? property.city ?? 'Lokasi belum tercatat'}
          {property.starRating === undefined ? null : (
            <>
              <span aria-hidden="true">·</span>
              <span className="flex items-center gap-1">
                <Star className="size-4 fill-current" aria-hidden="true" />
                <span className="sr-only">Peringkat</span>
                {property.starRating}
              </span>
            </>
          )}
        </p>
      </header>

      {property.amenities.length === 0 ? null : (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium">Fasilitas</h2>
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {property.amenities.map((amenity) => (
              <AmenityItem key={amenity}>{amenityLabel(amenity)}</AmenityItem>
            ))}
          </ul>
        </section>
      )}

      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-medium">Pilihan kamar</h2>
          <p className="text-xs text-muted-foreground">
            {property.suppliers.length > 1
              ? `Harga dari ${String(property.suppliers.length)} penyedia, ditampilkan berdampingan.`
              : 'Seluruh tarif yang tersedia untuk tanggal ini.'}
          </p>
        </div>

        <ul className="rounded-xl border border-border bg-card px-4">
          {property.offers.map((offer) => (
            <RatePlanRow
              key={`${offer.supplier}:${offer.supplierRatePlanId}`}
              offer={offer}
              nights={nights}
              isCheapest={offer === cheapest}
            />
          ))}
        </ul>
      </section>

      {/* Aksi utama menempel di bawah layar pada mobile. */}
      <div className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-card p-4 lg:hidden">
        <Button variant="primary" className="w-full">
          Pilih kamar
        </Button>
      </div>
    </>
  )
}

/**
 * Galeri.
 *
 * Katalog belum menyimpan foto — Step 12b sengaja tidak mengisinya. Yang
 * ditampilkan sekarang adalah penampung dengan rasio yang sama dengan foto
 * sungguhan nanti, jadi tata letaknya tidak akan berubah ketika foto masuk.
 */
function Gallery({ property }: { readonly property: SearchProperty }) {
  return (
    <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
      <PropertyPhoto
        name={property.name}
        seed={property.ref}
        priority
        className="sm:aspect-[16/10]"
        sizes="(min-width: 640px) 640px, 100vw"
      />
      <div className="hidden gap-3 sm:grid">
        <PropertyPhoto name={property.name} seed={`${property.ref}-2`} className="aspect-[4/3]" />
        <PropertyPhoto name={property.name} seed={`${property.ref}-3`} className="aspect-[4/3]" />
      </div>
    </div>
  )
}

function DetailSkeleton() {
  return (
    <div aria-busy="true" aria-live="polite" className="flex flex-col gap-6">
      <span className="sr-only">Memuat properti</span>
      <Skeleton className="aspect-[16/10] w-full rounded-xl" />
      <Skeleton className="h-8 w-80 max-w-full" />
      <Skeleton className="h-4 w-60" />
      <Skeleton className="h-48 w-full rounded-xl" />
    </div>
  )
}

function lowestOf(offers: readonly Offer[]): Offer | undefined {
  return offers.reduce<Offer | undefined>(
    (best, offer) =>
      best === undefined || offer.total.amountMinor < best.total.amountMinor ? offer : best,
    undefined,
  )
}
