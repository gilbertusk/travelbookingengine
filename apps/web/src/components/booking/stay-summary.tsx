import { format, parseISO } from 'date-fns'
import { id as localeId } from 'date-fns/locale'
import { CalendarDays, MapPin, Users } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { nightsBetween } from '@/features/search/criteria'
import type { Money } from '@/features/booking/types'
import { formatMoney } from './rate-change-dialog'

/**
 * Ringkasan menginap yang TERUS terlihat selama alur pemesanan.
 *
 * Properti, tanggal, jumlah malam, tamu, dan rincian biaya lengkap — termasuk
 * pajak — sejak langkah pertama. Harga yang baru menyebut pajaknya di langkah
 * terakhir terasa seperti jebakan, dan itu satu-satunya hal yang dilarang
 * PriceDisplay sejak Step 14.
 */

export interface CostLine {
  readonly label: string
  readonly amount: Money
}

export interface StayPrice {
  readonly lines: readonly CostLine[]
  readonly total: Money
}

export interface StaySummaryProps {
  readonly propertyName: string
  readonly roomName?: string | undefined
  readonly ratePlanName?: string | undefined
  readonly city?: string | undefined
  readonly checkIn: string
  readonly checkOut: string
  readonly guests: number
  /** `undefined` selama harganya belum diketahui — ditampilkan sebagai skeleton. */
  readonly price: StayPrice | undefined
}

export function StaySummary({
  propertyName,
  roomName,
  ratePlanName,
  city,
  checkIn,
  checkOut,
  guests,
  price,
}: StaySummaryProps) {
  const nights = nightsBetween(checkIn, checkOut)

  return (
    <section aria-labelledby="ringkasan-menginap" className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 id="ringkasan-menginap" className="text-h3 font-medium">
          {propertyName}
        </h2>
        {roomName === undefined ? null : (
          <p className="text-small text-foreground">
            {roomName}
            {ratePlanName === undefined ? null : (
              <span className="text-muted-foreground"> · {ratePlanName}</span>
            )}
          </p>
        )}
      </div>

      <ul className="flex flex-col gap-2 text-small text-muted-foreground">
        {city === undefined ? null : <Fact icon={<MapPin />}>{city}</Fact>}
        <Fact icon={<CalendarDays />}>
          {formatDay(checkIn)} – {formatDay(checkOut)} · {String(nights)} malam
        </Fact>
        <Fact icon={<Users />}>{String(guests)} tamu</Fact>
      </ul>

      {price === undefined ? (
        <div aria-busy="true" className="flex flex-col gap-2 border-t border-border pt-4">
          <span className="sr-only">Memuat rincian harga</span>
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-7 w-1/2 self-end" />
        </div>
      ) : (
        <dl className="flex flex-col gap-2 border-t border-border pt-4 text-small">
          {price.lines.map((line) => (
            <div key={line.label} className="flex justify-between gap-4">
              <dt className="text-muted-foreground">{line.label}</dt>
              <dd className="tabular-nums">{formatMoney(line.amount)}</dd>
            </div>
          ))}
          <div className="flex items-baseline justify-between gap-4 border-t border-border pt-3">
            <dt className="font-medium">Total</dt>
            <dd className="text-h3 font-semibold tabular-nums">{formatMoney(price.total)}</dd>
          </div>
        </dl>
      )}
    </section>
  )
}

function Fact({
  icon,
  children,
}: {
  readonly icon: React.ReactNode
  readonly children: React.ReactNode
}) {
  return (
    <li className="flex items-center gap-2 [&_svg]:size-4 [&_svg]:shrink-0">
      <span aria-hidden="true">{icon}</span>
      {children}
    </li>
  )
}

export function formatDay(isoDate: string): string {
  return format(parseISO(isoDate), 'EEE, d MMM yyyy', { locale: localeId })
}
