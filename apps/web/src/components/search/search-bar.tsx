'use client'

import { format } from 'date-fns'
import { id as localeId } from 'date-fns/locale'
import { CalendarDays, Search, Users } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import type { DateRange } from 'react-day-picker'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { MAX_GUESTS, MAX_STAY_NIGHTS, searchHref } from '@/features/search/criteria'
import type { SearchCriteria } from '@/features/search/criteria'
import { cn } from '@/lib/cn'
import { CityAutocomplete } from './city-autocomplete'

/**
 * Batang pencarian.
 *
 * Kriteria dikirim lewat URL, bukan state yang dioper antar halaman —
 * lihat features/search/criteria.ts. Komponen ini hanya menyusunnya.
 *
 * Rentang tanggal dibatasi di tiga tempat sekaligus, dan ketiganya perlu:
 * tanggal lampau dinonaktifkan di kalender, rentang maksimum dibatasi saat
 * pemilihan, dan keduanya diperiksa lagi sebelum dikirim. Yang pertama
 * membantu pengguna, yang ketiga menjaga permintaan yang datang dari tautan
 * yang disusun tangan.
 */

export interface SearchBarProps {
  /** Kriteria awal, bila batang ini muncul di halaman hasil. */
  readonly initial?: SearchCriteria | undefined
  readonly className?: string
  readonly compact?: boolean
}

export function SearchBar({ initial, className, compact = false }: SearchBarProps) {
  const router = useRouter()
  const [city, setCity] = useState(initial?.city ?? '')
  const [range, setRange] = useState<DateRange | undefined>(toRange(initial))
  const [guests, setGuests] = useState(String(initial?.guests ?? 2))
  const [problem, setProblem] = useState<string | undefined>(undefined)

  function submit(): void {
    const invalid = validate(city, range)
    if (invalid !== undefined) {
      setProblem(invalid)
      return
    }

    setProblem(undefined)

    // Penyaring yang sedang aktif ikut terbawa. Mengubah tanggal tidak boleh
    // diam-diam menghapus penyaring harga yang baru saja dipilih pengguna.
    router.push(
      searchHref({
        ...(initial ?? EMPTY_FILTERS),
        city: city.trim(),
        checkIn: toIsoDate(range?.from),
        checkOut: toIsoDate(range?.to),
        guests: Number(guests),
      }),
    )
  }

  return (
    <form
      className={cn(
        'rounded-xl border border-border bg-card p-4 shadow-float',
        compact ? 'sm:p-4' : 'sm:p-5',
        className,
      )}
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <div className="grid gap-4 md:grid-cols-[1.4fr_1.6fr_auto_auto] md:items-end">
        <CityAutocomplete value={city} onChange={setCity} />

        <div className="flex flex-col gap-2">
          <Label htmlFor="tanggal" className="flex items-center gap-2">
            <CalendarDays className="size-3.5 text-muted-foreground" aria-hidden="true" />
            Tanggal menginap
          </Label>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                id="tanggal"
                type="button"
                variant="secondary"
                className="h-11 w-full justify-start font-normal"
              >
                {formatRange(range)}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0">
              <Calendar
                mode="range"
                numberOfMonths={1}
                selected={range}
                onSelect={setRange}
                disabled={{ before: startOfToday() }}
                className="sm:hidden"
              />
              <Calendar
                mode="range"
                numberOfMonths={2}
                selected={range}
                onSelect={setRange}
                disabled={{ before: startOfToday() }}
                className="hidden sm:block"
              />
            </PopoverContent>
          </Popover>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="tamu" className="flex items-center gap-2">
            <Users className="size-3.5 text-muted-foreground" aria-hidden="true" />
            Tamu
          </Label>
          <Select value={guests} onValueChange={setGuests}>
            <SelectTrigger id="tamu" className="md:w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Array.from({ length: MAX_GUESTS }, (_unused, index) => String(index + 1)).map(
                (count) => (
                  <SelectItem key={count} value={count}>
                    {count} tamu
                  </SelectItem>
                ),
              )}
            </SelectContent>
          </Select>
        </div>

        {/* Satu-satunya pemakaian warna aksen di layar ini. */}
        <Button type="submit" variant="primary" className="md:w-auto">
          <Search />
          Cari
        </Button>
      </div>

      {problem === undefined ? null : (
        // `role="alert"` membuatnya diumumkan begitu muncul. Pesan galat yang
        // hanya terlihat adalah pesan galat yang tidak sampai ke sebagian
        // pengguna.
        <p role="alert" className="mt-4 text-sm text-destructive">
          {problem}
        </p>
      )}
    </form>
  )
}

const EMPTY_FILTERS = {
  sort: 'relevansi',
  amenities: [],
  refundableOnly: false,
  breakfastIncluded: false,
} satisfies Omit<SearchCriteria, 'city' | 'checkIn' | 'checkOut' | 'guests'>

function validate(city: string, range: DateRange | undefined): string | undefined {
  if (city.trim().length < 2) return 'Isi kota atau daerah tujuan lebih dulu.'
  if (range?.from === undefined || range.to === undefined) return 'Pilih tanggal masuk dan keluar.'

  const nights = Math.round((range.to.getTime() - range.from.getTime()) / 86_400_000)
  if (nights < 1) return 'Tanggal keluar harus setelah tanggal masuk.'
  if (nights > MAX_STAY_NIGHTS) return `Menginap paling lama ${String(MAX_STAY_NIGHTS)} malam.`

  return undefined
}

function toRange(criteria: SearchCriteria | undefined): DateRange | undefined {
  if (criteria === undefined) return undefined

  return { from: fromIsoDate(criteria.checkIn), to: fromIsoDate(criteria.checkOut) }
}

/**
 * Tanggal menginap adalah tanggal kalender, bukan titik waktu.
 *
 * Diurai sebagai waktu LOKAL — `new Date('2026-11-10')` diurai sebagai UTC,
 * dan di Jakarta itu menggeser tanggalnya mundur satu hari begitu ditampilkan.
 * Lihat CONVENTIONS.md bagian 10.
 */
function fromIsoDate(value: string): Date {
  const [year = 0, month = 1, day = 1] = value.split('-').map(Number)

  return new Date(year, month - 1, day)
}

function toIsoDate(date: Date | undefined): string {
  return date === undefined ? '' : format(date, 'yyyy-MM-dd')
}

function startOfToday(): Date {
  const now = new Date()

  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

function formatRange(range: DateRange | undefined): string {
  if (range?.from === undefined) return 'Pilih tanggal'

  const from = format(range.from, 'd MMM', { locale: localeId })
  if (range.to === undefined) return `${from} — pilih tanggal keluar`

  return `${from} — ${format(range.to, 'd MMM yyyy', { locale: localeId })}`
}
