import { MapPin, Star } from 'lucide-react'
import Link from 'next/link'
import { amenityLabel } from '@/features/search/criteria'
import { cn } from '@/lib/cn'
import { PriceDisplay } from './price-display'
import { PropertyPhoto } from './property-photo'
import type { SearchProperty } from '@/features/search/types'

/**
 * Satu hotel di daftar hasil.
 *
 * Empat keputusan yang tertanam di bentuknya:
 *
 * 1. **Seluruh kartu dapat diklik**, bukan hanya tombolnya. Tetapi yang
 *    menjadi tautan adalah JUDULNYA, dengan lapisan tak terlihat yang
 *    memperluas wilayah kliknya ke seluruh kartu. Membungkus kartu dengan
 *    `<a>` akan memasukkan harga, bintang, dan seluruh fasilitas ke dalam
 *    nama tautan yang dibacakan pembaca layar — satu tautan sepanjang
 *    paragraf, dan mustahil dikenali dari daftar tautan.
 *
 * 2. **Tanpa kartu bersarang.** DESIGN-SYSTEM.md melarangnya, jadi label
 *    supplier dan fasilitas memakai teks bertanda, bukan `Card` di dalam
 *    `Card`.
 *
 * 3. **Label supplier halus, bukan badge mencolok.** Pengguna memilih hotel,
 *    bukan penyedia; nama penyedia hanya keterangan asal harga.
 *
 * 4. **Properti belum terpetakan tetap ditampilkan**, ditandai, dan TIDAK
 *    menjadi tautan — ia tidak punya URL yang stabil. Menyembunyikannya
 *    berarti kehilangan inventaris.
 */

const MAX_AMENITIES_SHOWN = 4

export interface PropertyCardProps {
  readonly property: SearchProperty
  readonly nights: number
  /** Query string kriteria, diteruskan ke halaman detail. */
  readonly query: string
  /** Urutan kartu, untuk jeda kemunculan bertahap. */
  readonly index: number
}

export function PropertyCard({ property, nights, query, index }: PropertyCardProps) {
  const href = property.slug === undefined ? undefined : `/properti/${property.slug}?${query}`
  const cheapest = property.offers[0]

  return (
    <article
      data-anchor-key={property.ref}
      style={enterDelay(index)}
      className={cn(
        'group relative grid gap-4 rounded-xl border border-border bg-card p-4',
        'transition-shadow duration-200 hover:shadow-float',
        'motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2',
        'sm:grid-cols-[13rem_1fr]',
      )}
    >
      <PropertyPhoto name={property.name} seed={property.ref} />

      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:justify-between">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-col gap-1">
            <h3 className="text-base font-medium leading-snug text-foreground">
              {href === undefined ? (
                property.name
              ) : (
                // Lapisan tak terlihat memperluas wilayah klik ke seluruh
                // kartu tanpa memperpanjang nama tautannya.
                <Link href={href} className="after:absolute after:inset-0 after:content-['']">
                  {property.name}
                </Link>
              )}
            </h3>

            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <MapPin className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{property.city ?? 'Lokasi belum tercatat'}</span>
              {property.starRating === undefined ? null : (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="flex items-center gap-1">
                    <Star className="size-3.5 shrink-0 fill-current" aria-hidden="true" />
                    <span className="sr-only">Peringkat</span>
                    {property.starRating}
                  </span>
                </>
              )}
            </p>
          </div>

          <Amenities amenities={property.amenities} />

          {property.mapped ? null : (
            <p className="text-xs text-muted-foreground">
              Properti baru dari penyedia — keterangannya masih seperti yang mereka kirim.
            </p>
          )}
        </div>

        <div className="flex shrink-0 flex-col items-end justify-between gap-2">
          <PriceDisplay
            total={property.lowestTotal}
            nights={nights}
            {...(cheapest === undefined ? {} : { tax: cheapest.tax, taxName: cheapest.taxName })}
          />
          <Suppliers suppliers={property.suppliers} />
        </div>
      </div>
    </article>
  )
}

function Amenities({ amenities }: { readonly amenities: readonly string[] }) {
  if (amenities.length === 0) return null

  const shown = amenities.slice(0, MAX_AMENITIES_SHOWN)
  const rest = amenities.length - shown.length

  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {shown.map((amenity) => (
        <li key={amenity}>{amenityLabel(amenity)}</li>
      ))}
      {rest > 0 ? <li>+{rest} lainnya</li> : null}
    </ul>
  )
}

/**
 * Asal harga, disebutkan dengan halus.
 *
 * Ketika lebih dari satu penyedia menawarkan hotel yang sama, jumlahnya yang
 * disebut — bukan seluruh namanya. "3 penyedia" memberi tahu pengguna bahwa
 * ada yang bisa dibandingkan, dan halaman detail yang menunjukkan apa.
 */
function Suppliers({ suppliers }: { readonly suppliers: readonly string[] }) {
  if (suppliers.length === 0) return null

  return (
    <p className="text-xs text-muted-foreground">
      {suppliers.length === 1
        ? `via ${suppliers[0] ?? ''}`
        : `${String(suppliers.length)} penyedia menawarkan`}
    </p>
  )
}

/**
 * Jeda kemunculan bertahap: 30ms per kartu, maksimum sepuluh kartu pertama.
 *
 * DESIGN-SYSTEM.md bagian 8. Batas sepuluh itu penting — tanpa batas, kartu
 * kelima puluh baru muncul satu setengah detik setelah yang pertama, dan
 * pengguna yang langsung menggulir ke bawah melihat halaman kosong.
 *
 * Kelas `motion-safe:` yang memakainya, jadi `prefers-reduced-motion`
 * mematikan seluruh animasinya dan jeda ini tidak berpengaruh apa pun.
 */
const STAGGER_MS = 30
const MAX_STAGGERED = 10

function enterDelay(index: number): { animationDelay: string } | undefined {
  if (index >= MAX_STAGGERED) return undefined

  return { animationDelay: `${String(index * STAGGER_MS)}ms` }
}
