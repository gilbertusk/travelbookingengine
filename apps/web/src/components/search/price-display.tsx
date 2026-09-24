import { formatRupiah } from '@/features/search/criteria'
import { cn } from '@/lib/cn'
import type { Money } from '@/features/search/types'

/**
 * Harga jual beserta rinciannya.
 *
 * Dua aturan dari DESIGN-SYSTEM.md yang mudah dilanggar tanpa sadar:
 *
 * 1. **Harga menonjol lewat UKURAN dan KETEBALAN, bukan warna.** Warna aksen
 *    disediakan untuk satu aksi utama per layar; memakainya untuk harga di
 *    dua puluh kartu sekaligus membuat aksi utamanya tidak lagi menonjol, dan
 *    membuat harga tidak terbaca bagi yang kesulitan membedakan warna.
 *
 * 2. **Rincian pajak selalu terlihat, tidak disembunyikan di balik klik.**
 *    Harga yang berubah di langkah terakhir pemesanan adalah cara tercepat
 *    kehilangan kepercayaan, dan satu-satunya pencegahnya adalah menyebutkan
 *    seluruhnya sejak awal.
 */

export interface PriceDisplayProps {
  readonly total: Money
  readonly nights: number
  readonly tax?: Money | undefined
  readonly taxName?: string | undefined
  readonly size?: 'md' | 'lg'
  readonly className?: string
}

export function PriceDisplay({
  total,
  nights,
  tax,
  taxName,
  size = 'md',
  className,
}: PriceDisplayProps) {
  const nightsLabel = nights === 1 ? '1 malam' : `${String(nights)} malam`

  return (
    <div className={cn('flex flex-col items-end gap-1 text-right', className)}>
      <p
        className={cn(
          'font-semibold tabular-nums tracking-tight text-foreground',
          size === 'lg' ? 'text-2xl' : 'text-xl',
        )}
      >
        {formatRupiah(total.amountMinor)}
      </p>

      <p className="text-xs text-muted-foreground">
        total untuk {nightsLabel}
        {tax === undefined ? null : (
          <>
            {' · '}
            <span>
              termasuk {taxName ?? 'pajak'} {formatRupiah(tax.amountMinor)}
            </span>
          </>
        )}
      </p>
    </div>
  )
}
