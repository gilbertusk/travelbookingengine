'use client'

import { format } from 'date-fns'
import { id as localeId } from 'date-fns/locale'
import { CalendarDays, MapPin, Search, Users } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import type { DateRange } from 'react-day-picker'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

/**
 * Batang pencarian.
 *
 * Kerangka visual dan interaksinya sudah benar; penyambungan ke search-service
 * terjadi pada Step 13–14. Yang sengaja dibuat sekarang adalah bentuknya,
 * karena inilah elemen utama beranda dan seluruh tata letak hero bergantung
 * pada ukurannya.
 *
 * Setiap bidang punya `<label>` sungguhan, bukan placeholder yang menyamar
 * sebagai label — placeholder hilang begitu pengguna mengetik, dan bersamanya
 * hilang pula satu-satunya keterangan tentang isi bidang itu.
 */

const MAX_GUESTS = 8

export function SearchBar() {
  const router = useRouter()
  const [city, setCity] = useState('')
  const [range, setRange] = useState<DateRange | undefined>(undefined)
  const [guests, setGuests] = useState('2')

  function submit(): void {
    const params = new URLSearchParams({ kota: city, tamu: guests })
    if (range?.from !== undefined) params.set('mulai', toIsoDate(range.from))
    if (range?.to !== undefined) params.set('selesai', toIsoDate(range.to))

    router.push(`/cari?${params.toString()}`)
  }

  return (
    <form
      className="rounded-xl border border-border bg-card p-4 shadow-float sm:p-5"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <div className="grid gap-4 md:grid-cols-[1.4fr_1.6fr_auto_auto] md:items-end">
        <div className="flex flex-col gap-2">
          <Label htmlFor="kota" className="flex items-center gap-2">
            <MapPin className="size-3.5 text-muted-foreground" aria-hidden="true" />
            Kota atau daerah
          </Label>
          <Input
            id="kota"
            value={city}
            onChange={(event) => {
              setCity(event.target.value)
            }}
            placeholder="Bali, Yogyakarta, Bandung…"
            autoComplete="off"
          />
        </div>

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
                disabled={{ before: new Date() }}
                className="sm:hidden"
              />
              <Calendar
                mode="range"
                numberOfMonths={2}
                selected={range}
                onSelect={setRange}
                disabled={{ before: new Date() }}
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
              {Array.from({ length: MAX_GUESTS }, (_, index) => String(index + 1)).map((count) => (
                <SelectItem key={count} value={count}>
                  {count} tamu
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Satu-satunya pemakaian warna aksen di layar ini. */}
        <Button type="submit" variant="primary" className="md:w-auto">
          <Search />
          Cari
        </Button>
      </div>
    </form>
  )
}

function formatRange(range: DateRange | undefined): string {
  if (range?.from === undefined) return 'Pilih tanggal'

  const from = format(range.from, 'd MMM', { locale: localeId })
  if (range.to === undefined) return `${from} — pilih tanggal keluar`

  return `${from} — ${format(range.to, 'd MMM yyyy', { locale: localeId })}`
}

/**
 * Tanggal menginap adalah tanggal kalender, bukan titik waktu.
 *
 * `toISOString()` mengubahnya ke UTC lebih dulu, sehingga tanggal 1 di
 * Jakarta terkirim sebagai tanggal 30 bulan sebelumnya. Lihat CONVENTIONS.md
 * bagian 10.
 */
function toIsoDate(date: Date): string {
  return format(date, 'yyyy-MM-dd')
}
