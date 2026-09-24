'use client'

import { Star, X } from 'lucide-react'
import { AMENITIES, activeFilters, amenityLabel, formatRupiah } from '@/features/search/criteria'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/cn'
import type { SearchCriteria } from '@/features/search/criteria'

/**
 * Penyaring hasil (FR-06).
 *
 * Seluruhnya mengubah URL, bukan state lokal — dan itu bukan detail
 * implementasi melainkan syarat: penyaring yang hanya hidup di memori hilang
 * saat halaman dimuat ulang, dan tautan yang dibagikan menunjukkan hasil yang
 * berbeda dari yang dilihat pengirimnya.
 *
 * Penyaring harga bekerja pada HARGA JUAL, bukan harga penyedia — itulah yang
 * dilihat pengguna, dan menyaring pada angka lain berarti membuang hotel yang
 * sebenarnya masuk anggarannya.
 */

const PRICE_STEPS = [500_000, 1_000_000, 2_000_000, 5_000_000] as const
const STAR_STEPS = [3, 4, 5] as const

export interface FiltersPanelProps {
  readonly criteria: SearchCriteria
  readonly onChange: (criteria: SearchCriteria) => void
  readonly className?: string
}

export function FiltersPanel({ criteria, onChange, className }: FiltersPanelProps) {
  const hasAny = activeFilters(criteria).length > 0

  return (
    <div className={cn('flex flex-col gap-6', className)}>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-foreground">Penyaring</h2>
        {hasAny ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              onChange(cleared(criteria))
            }}
          >
            Hapus semua
          </Button>
        ) : null}
      </div>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Harga maksimum
        </legend>
        <div className="flex flex-wrap gap-2">
          {PRICE_STEPS.map((step) => (
            <Toggle
              key={step}
              pressed={criteria.maxTotalMinor === step}
              onPressedChange={(pressed) => {
                onChange({ ...criteria, maxTotalMinor: pressed ? step : undefined })
              }}
            >
              {formatRupiah(step)}
            </Toggle>
          ))}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Peringkat
        </legend>
        <div className="flex flex-wrap gap-2">
          {STAR_STEPS.map((step) => (
            <Toggle
              key={step}
              pressed={criteria.minStarRating === step}
              onPressedChange={(pressed) => {
                onChange({ ...criteria, minStarRating: pressed ? step : undefined })
              }}
            >
              <Star className="size-3.5 fill-current" aria-hidden="true" />
              {/* Angka dan tanda plus untuk mata; kalimat utuh untuk pembaca
                  layar. Menggabungkan keduanya menghasilkan nama seperti
                  "4bintang ke atas" — terbaca, tetapi bukan yang dimaksud. */}
              <span aria-hidden="true">{step}+</span>
              <span className="sr-only">{step} bintang ke atas</span>
            </Toggle>
          ))}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Syarat pemesanan
        </legend>
        <div className="flex flex-col gap-3">
          <Check
            id="filter-refundable"
            label="Bisa dibatalkan"
            checked={criteria.refundableOnly}
            onChange={(checked) => {
              onChange({ ...criteria, refundableOnly: checked })
            }}
          />
          <Check
            id="filter-sarapan"
            label="Termasuk sarapan"
            checked={criteria.breakfastIncluded}
            onChange={(checked) => {
              onChange({ ...criteria, breakfastIncluded: checked })
            }}
          />
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Fasilitas
        </legend>
        <div className="flex flex-wrap gap-2">
          {AMENITIES.map((amenity) => (
            <Toggle
              key={amenity}
              pressed={criteria.amenities.includes(amenity)}
              onPressedChange={(pressed) => {
                onChange({
                  ...criteria,
                  amenities: pressed
                    ? [...criteria.amenities, amenity].sort()
                    : criteria.amenities.filter((item) => item !== amenity),
                })
              }}
            >
              {amenityLabel(amenity)}
            </Toggle>
          ))}
        </div>
      </fieldset>
    </div>
  )
}

/**
 * Tombol dua keadaan.
 *
 * `aria-pressed`, bukan checkbox tersamar. Pembaca layar mengumumkan
 * "ditekan" atau "tidak ditekan" untuk tombol seperti ini, dan itulah yang
 * menjelaskan keadaannya tanpa perlu melihat warnanya.
 */
function Toggle({
  pressed,
  onPressedChange,
  children,
}: {
  readonly pressed: boolean
  readonly onPressedChange: (pressed: boolean) => void
  readonly children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={() => {
        onPressedChange(!pressed)
      }}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-3 py-2 text-xs',
        'transition-colors duration-150',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        pressed
          ? 'border-foreground bg-foreground text-background'
          : 'border-border bg-card text-muted-foreground hover:border-foreground/40 hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

function Check({
  id,
  label,
  checked,
  onChange,
}: {
  readonly id: string
  readonly label: string
  readonly checked: boolean
  readonly onChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-center gap-3">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(event) => {
          onChange(event.target.checked)
        }}
        className="size-4 rounded border-input accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      />
      <Label htmlFor={id} className="cursor-pointer text-sm font-normal">
        {label}
      </Label>
    </div>
  )
}

function cleared(criteria: SearchCriteria): SearchCriteria {
  return {
    ...criteria,
    minStarRating: undefined,
    maxTotalMinor: undefined,
    amenities: [],
    refundableOnly: false,
    breakfastIncluded: false,
  }
}

/**
 * Penyaring aktif sebagai chip yang dapat dilepas satu per satu.
 *
 * Diturunkan dari kriteria, bukan disimpan sendiri — itu yang membuat
 * mustahil ada chip yang tertinggal setelah penyaringnya dilepas lewat panel.
 */
export function FilterChips({
  criteria,
  onChange,
}: {
  readonly criteria: SearchCriteria
  readonly onChange: (criteria: SearchCriteria) => void
}) {
  const filters = activeFilters(criteria)
  if (filters.length === 0) return null

  return (
    <ul className="flex flex-wrap gap-2">
      {filters.map((filter) => (
        <li key={filter.id}>
          <button
            type="button"
            onClick={() => {
              onChange(filter.remove(criteria))
            }}
            className={cn(
              'inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-2 text-xs text-foreground',
              'transition-colors duration-150 hover:border-foreground/40',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
            )}
          >
            {filter.label}
            <X className="size-3" aria-hidden="true" />
            <span className="sr-only">Hapus penyaring</span>
          </button>
        </li>
      ))}
    </ul>
  )
}
