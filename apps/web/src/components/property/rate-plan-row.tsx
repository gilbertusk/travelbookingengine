import { Check, Coffee, ShieldCheck, ShieldOff, X } from 'lucide-react'
import Link from 'next/link'
import { PriceDisplay } from '@/components/search/price-display'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'
import type { Offer } from '@/features/search/types'

/**
 * Satu tawaran kamar.
 *
 * FR-11 mewajibkan kebijakan pembatalan dan inklusi TERLIHAT TANPA DIKLIK.
 * Itu kewajiban, bukan preferensi desain, dan konsekuensinya pada bentuk
 * komponen ini nyata: tidak ada accordion, tidak ada tooltip, tidak ada
 * "lihat detail". Keduanya baris teks biasa di bawah nama kamar.
 *
 * Alasannya sederhana. Kebijakan pembatalan adalah satu-satunya hal yang
 * membedakan dua tarif yang harganya berbeda seratus ribu, dan pengguna yang
 * harus mengklik untuk mengetahuinya akan memilih yang lebih murah tanpa tahu
 * apa yang dilepaskannya.
 *
 * Penyedia disebut di sini, tidak seperti di kartu hasil: pada halaman ini
 * pengguna sedang MEMBANDINGKAN tawaran, dan asal tawaran adalah bagian dari
 * yang dibandingkan.
 */

export interface RatePlanRowProps {
  readonly offer: Offer
  readonly nights: number
  /** Tawaran termurah untuk properti ini. Ditandai supaya mudah dikenali. */
  readonly isCheapest: boolean
  /** Alur pemesanan untuk tawaran ini. Lihat features/booking/selection.ts. */
  readonly href: string
}

export function RatePlanRow({ offer, nights, isCheapest, href }: RatePlanRowProps) {
  return (
    <li
      className={cn(
        'flex flex-col gap-4 border-b border-border py-4 last:border-b-0',
        'sm:flex-row sm:items-start sm:justify-between',
      )}
    >
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-medium text-foreground">{offer.roomTypeName}</h3>
          {isCheapest ? (
            <span className="rounded-full border border-success px-2 py-1 text-xs text-success">
              Termurah
            </span>
          ) : null}
        </div>

        <p className="text-sm text-muted-foreground">{offer.ratePlanName}</p>

        {/* Keduanya selalu terlihat. FR-11. */}
        <ul className="flex flex-col gap-1 text-xs">
          <Fact
            ok={offer.refundable}
            okIcon={<ShieldCheck className="size-3.5 shrink-0" aria-hidden="true" />}
            noIcon={<ShieldOff className="size-3.5 shrink-0" aria-hidden="true" />}
            okLabel={cancellationLabel(offer.freeCancellationDays)}
            noLabel="Tidak bisa dibatalkan"
          />
          <Fact
            ok={offer.breakfastIncluded}
            okIcon={<Coffee className="size-3.5 shrink-0" aria-hidden="true" />}
            noIcon={<X className="size-3.5 shrink-0" aria-hidden="true" />}
            okLabel="Termasuk sarapan"
            noLabel="Tanpa sarapan"
          />
        </ul>

        <p className="text-xs text-muted-foreground">
          via {offer.supplier}
          {offer.unitsLeft <= LOW_STOCK ? (
            <>
              {' · '}
              <span className="text-warning">tinggal {offer.unitsLeft} kamar</span>
            </>
          ) : null}
        </p>
      </div>

      <div className="flex shrink-0 items-end gap-4 sm:flex-col sm:items-end">
        <PriceDisplay total={offer.total} nights={nights} tax={offer.tax} taxName={offer.taxName} />
        <Button asChild variant="secondary" size="sm">
          <Link href={href} aria-label={`Pilih ${offer.roomTypeName}, ${offer.ratePlanName}`}>
            Pilih
          </Link>
        </Button>
      </div>
    </li>
  )
}

/** Ambang "tinggal sedikit". Di atas ini, menyebut sisa kamar hanya menakut-nakuti. */
const LOW_STOCK = 3

function Fact({
  ok,
  okIcon,
  noIcon,
  okLabel,
  noLabel,
}: {
  readonly ok: boolean
  readonly okIcon: React.ReactNode
  readonly noIcon: React.ReactNode
  readonly okLabel: string
  readonly noLabel: string
}) {
  return (
    <li className={cn('flex items-center gap-2', ok ? 'text-success' : 'text-muted-foreground')}>
      {ok ? okIcon : noIcon}
      {ok ? okLabel : noLabel}
    </li>
  )
}

function cancellationLabel(freeCancellationDays: number | undefined): string {
  if (freeCancellationDays === undefined) return 'Bisa dibatalkan'
  if (freeCancellationDays === 0) return 'Bisa dibatalkan sampai hari menginap'

  return `Gratis batal sampai ${String(freeCancellationDays)} hari sebelum menginap`
}

/** Ikon centang dipakai daftar fasilitas di halaman detail. */
export function AmenityItem({ children }: { readonly children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-2 text-sm text-muted-foreground">
      <Check className="size-4 shrink-0 text-success" aria-hidden="true" />
      {children}
    </li>
  )
}
