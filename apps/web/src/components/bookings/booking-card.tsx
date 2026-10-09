import { format, parseISO } from 'date-fns'
import { id as localeId } from 'date-fns/locale'
import Link from 'next/link'
import { formatMoney } from '@/components/booking/rate-change-dialog'
import { bookingStatusHref } from '@/features/booking/selection'
import { statusOf } from '@/features/bookings/presentation'
import type { BookingListItem } from '@/features/bookings/types'
import { cn } from '@/lib/cn'
import { StatusBadge } from './status-badge'

/**
 * Satu pemesanan di daftar: properti, tanggal, booking reference, status, dan
 * nilai (FR-25). Seluruh kartu dapat diklik — targetnya satu tautan, bukan
 * tombol kecil di pojok.
 */
export function BookingCard({ item }: { readonly item: BookingListItem }) {
  const status = statusOf(item)
  const name = item.propertyName ?? `Penginapan di ${item.city}`

  return (
    <Link
      href={bookingStatusHref(item.id)}
      className={cn(
        'flex flex-col gap-4 rounded-lg border border-border bg-card p-5',
        'transition-colors duration-200 ease-[var(--ease-enter)] hover:bg-muted',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
        'sm:flex-row sm:items-start sm:justify-between',
      )}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <h3 className="text-h3 font-medium text-foreground">{name}</h3>
        {item.roomTypeName === null ? null : (
          <p className="text-small text-muted-foreground">{item.roomTypeName}</p>
        )}
        <p className="text-small text-foreground">
          {formatDay(item.checkIn)} – {formatDay(item.checkOut)} · {String(item.guests)} tamu
        </p>
        <p className="text-small text-muted-foreground">
          {item.supplierRef === null ? (
            'Kode pemesanan belum terbit'
          ) : (
            <>
              Kode pemesanan{' '}
              <span className="tabular-nums text-foreground">{item.supplierRef}</span>
            </>
          )}
        </p>
      </div>

      <div className="flex flex-row items-center justify-between gap-3 sm:flex-col sm:items-end">
        <StatusBadge status={status} />
        <p className="text-body font-semibold tabular-nums text-foreground">
          {formatMoney(item.total)}
        </p>
      </div>
    </Link>
  )
}

export function formatDay(isoDate: string): string {
  return format(parseISO(isoDate), 'd MMM yyyy', { locale: localeId })
}
