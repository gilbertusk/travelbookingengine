'use client'

import { Building2, MapPin } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useSuggestions } from '@/features/search/use-search'
import { cn } from '@/lib/cn'

/**
 * Masukan kota dengan saran otomatis (FR-08).
 *
 * Memakai pola combobox ARIA, bukan daftar `<div>` yang muncul di bawah
 * kotak. Perbedaannya nyata bagi pengguna pembaca layar: tanpa peran dan
 * atribut yang benar, munculnya daftar saran tidak diumumkan sama sekali, dan
 * panah bawah menggulir halaman alih-alih memindahkan sorotan.
 *
 * Papan ketik yang didukung, seluruhnya wajib:
 *
 *   ↓ / ↑   memindahkan sorotan, berputar di ujungnya
 *   Enter   memilih yang tersorot
 *   Escape  menutup tanpa mengubah apa pun
 *   Tab     menutup dan melanjutkan ke bidang berikutnya
 *
 * Yang TIDAK dilakukan: memilih otomatis saran pertama saat pengguna menekan
 * Enter tanpa menyorot apa pun. Pengguna yang mengetik "Bali" lalu menekan
 * Enter bermaksud mencari "Bali" — bukan "Balikpapan" yang kebetulan berada
 * di puncak daftar.
 */

export interface CityAutocompleteProps {
  readonly value: string
  readonly onChange: (city: string) => void
  readonly id?: string
}

export function CityAutocomplete({ value, onChange, id = 'kota' }: CityAutocompleteProps) {
  const listId = useId()
  const [open, setOpen] = useState(false)
  const [highlighted, setHighlighted] = useState(-1)
  const blurTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const { data } = useSuggestions(value)
  const options = toOptions(data)
  const visible = open && options.length > 0

  function choose(index: number): void {
    const option = options[index]
    if (option === undefined) return

    onChange(option.city)
    setOpen(false)
    setHighlighted(-1)
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Escape') {
      setOpen(false)
      setHighlighted(-1)
      return
    }

    if (!visible) {
      if (event.key === 'ArrowDown') setOpen(true)
      return
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setHighlighted((current) => (current + 1) % options.length)
      return
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlighted((current) => (current <= 0 ? options.length - 1 : current - 1))
      return
    }

    // Enter TANPA sorotan dibiarkan lewat — formulir yang mengirimkannya
    // adalah perilaku yang benar untuk pengguna yang sudah selesai mengetik.
    if (event.key === 'Enter' && highlighted >= 0) {
      event.preventDefault()
      choose(highlighted)
    }
  }

  return (
    <div className="relative flex flex-col gap-2">
      <Label htmlFor={id} className="flex items-center gap-2">
        <MapPin className="size-3.5 text-muted-foreground" aria-hidden="true" />
        Kota atau daerah
      </Label>

      <Input
        id={id}
        role="combobox"
        aria-expanded={visible}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          visible && highlighted >= 0 ? `${listId}-${String(highlighted)}` : undefined
        }
        autoComplete="off"
        value={value}
        placeholder="Bali, Yogyakarta, Bandung…"
        onChange={(event) => {
          onChange(event.target.value)
          setOpen(true)
          setHighlighted(-1)
        }}
        onKeyDown={onKeyDown}
        onFocus={() => {
          setOpen(true)
        }}
        onBlur={() => {
          // Ditunda supaya klik pada saran sempat terjadi. `mousedown` pada
          // saran memicu `blur` pada masukan sebelum `click` sampai, dan
          // menutup daftar seketika membuat saran mustahil diklik.
          blurTimer.current = setTimeout(() => {
            setOpen(false)
            setHighlighted(-1)
          }, 120)
        }}
      />

      <ul
        id={listId}
        role="listbox"
        aria-label="Saran kota dan properti"
        hidden={!visible}
        className={cn(
          'absolute top-full z-20 mt-2 max-h-72 w-full overflow-auto rounded-lg border border-border bg-popover p-1 shadow-float',
        )}
      >
        {options.map((option, index) => (
          // Papan ketik ditangani di masukan, bukan di setiap pilihan — itulah
          // pola combobox ARIA, dan `aria-activedescendant` yang
          // menghubungkan keduanya. Menaruh penangan tombol di setiap `li`
          // akan membuat masing-masing dapat difokuskan, dan Tab akan
          // menelusuri seluruh saran satu per satu alih-alih melanjutkan ke
          // bidang tanggal.
          // eslint-disable-next-line jsx-a11y/click-events-have-key-events -- lihat catatan di atas
          <li
            key={`${option.kind}:${option.key}`}
            id={`${listId}-${String(index)}`}
            role="option"
            aria-selected={index === highlighted}
            onMouseDown={() => {
              if (blurTimer.current !== undefined) clearTimeout(blurTimer.current)
            }}
            onClick={() => {
              choose(index)
            }}
            onMouseEnter={() => {
              setHighlighted(index)
            }}
            className={cn(
              'flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm',
              index === highlighted ? 'bg-muted text-foreground' : 'text-muted-foreground',
            )}
          >
            {option.kind === 'city' ? (
              <MapPin className="size-4 shrink-0" aria-hidden="true" />
            ) : (
              <Building2 className="size-4 shrink-0" aria-hidden="true" />
            )}
            <span className="min-w-0 flex-1 truncate text-foreground">{option.label}</span>
            <span className="shrink-0 text-xs">{option.hint}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

interface Option {
  readonly kind: 'city' | 'property'
  readonly key: string
  readonly label: string
  readonly hint: string
  /** Kota yang diisikan ke masukan ketika saran ini dipilih. */
  readonly city: string
}

/**
 * Kota lebih dulu, lalu properti.
 *
 * Urutan itu keputusan produk: yang dicari pengguna di kotak ini hampir
 * selalu tujuan, bukan hotel tertentu. Saran properti tetap ada karena
 * sebagian pengguna memang sudah tahu nama hotelnya — dan memilihnya mengisi
 * KOTANYA, bukan langsung melompat ke halaman hotel itu, supaya alur
 * pencariannya tetap satu jalur.
 */
function toOptions(data: ReturnType<typeof useSuggestions>['data']): readonly Option[] {
  if (data === undefined) return []

  // Bentuk jawabannya sudah divalidasi di features/search/api.ts, jadi kedua
  // larik ini pasti ada. Jawaban yang bentuknya lain menjadi daftar kosong di
  // sana — bukan halaman pencarian yang runtuh karena kotak isian di pojoknya.
  return [
    ...data.cities.map((city) => ({
      kind: 'city' as const,
      key: city.city,
      label: city.city,
      hint: `${String(city.propertyCount)} properti`,
      city: city.city,
    })),
    ...data.properties.slice(0, 5).map((property) => ({
      kind: 'property' as const,
      key: property.slug,
      label: property.name,
      hint: property.city,
      city: property.city,
    })),
  ]
}
