'use client'

import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SORT_ORDERS, type SearchCriteria, type SortOrder } from '@/features/search/criteria'

/**
 * Pengurutan hasil (FR-07).
 *
 * Label "Relevansi" sengaja tidak dijelaskan lebih jauh di antarmuka. Yang
 * dilakukannya — mendahulukan properti terpetakan, lalu bintang, lalu harga —
 * adalah detail yang tidak membantu pengguna memutuskan apa pun. Yang perlu
 * mereka tahu hanyalah bahwa ini pilihan bawaan yang masuk akal.
 */

const LABELS: Readonly<Record<SortOrder, string>> = {
  relevansi: 'Relevansi',
  harga: 'Harga terendah',
  bintang: 'Peringkat tertinggi',
}

export interface SortSelectProps {
  readonly criteria: SearchCriteria
  readonly onChange: (criteria: SearchCriteria) => void
}

export function SortSelect({ criteria, onChange }: SortSelectProps) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      {/* Labelnya disembunyikan dari mata pada layar sempit, bukan dihapus.
          Pada 375px, label ditambah pemilih ditambah tombol penyaring melebihi
          lebar layar — dan yang paling sedikit hilang maknanya adalah kata
          "Urutkan", karena pilihan yang sedang aktif sudah menyebut dirinya
          sendiri. Pembaca layar tetap mendapatkannya. */}
      <Label htmlFor="urutkan" className="hidden shrink-0 text-xs text-muted-foreground sm:block">
        Urutkan
      </Label>
      <span className="sr-only sm:hidden" id="urutkan-label">
        Urutkan hasil
      </span>
      <Select
        value={criteria.sort}
        onValueChange={(value) => {
          onChange({ ...criteria, sort: value as SortOrder })
        }}
      >
        <SelectTrigger id="urutkan" aria-labelledby="urutkan-label" className="w-40 sm:w-48">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SORT_ORDERS.map((order) => (
            <SelectItem key={order} value={order}>
              {LABELS[order]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
