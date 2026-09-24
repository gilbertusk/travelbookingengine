'use client'

import { useRef } from 'react'
import { useScrollAnchor } from '@/features/search/use-scroll-anchor'
import { nightsBetween, toQueryString, type SearchCriteria } from '@/features/search/criteria'
import { PropertyCard } from './property-card'
import type { SearchProperty } from '@/features/search/types'

/**
 * Daftar hasil.
 *
 * Satu-satunya tempat [useScrollAnchor] dipasang, dan alasannya ada di sana:
 * hasil yang menyisip di atas posisi baca pengguna adalah kesalahan yang
 * paling merusak kesan pada layar ini.
 *
 * Kunci setiap kartu adalah `ref` properti — pengenal internal untuk yang
 * terpetakan, pengenal gabungan penyedia untuk yang belum. BUKAN indeks:
 * daftar ini berubah urutan setiap kali penyedia lambat menjawab, dan kunci
 * berbasis indeks membuat React memakai ulang DOM kartu yang salah, sehingga
 * foto satu hotel muncul di atas nama hotel lain.
 */

export interface ResultsListProps {
  readonly properties: readonly SearchProperty[]
  readonly criteria: SearchCriteria
  /** Dimatikan saat pemuatan pertama — belum ada yang dibaca pengguna. */
  readonly anchorEnabled: boolean
}

export function ResultsList({ properties, criteria, anchorEnabled }: ResultsListProps) {
  const container = useRef<HTMLDivElement>(null)
  const nights = nightsBetween(criteria.checkIn, criteria.checkOut)
  const query = toQueryString(criteria)

  useScrollAnchor(container, {
    // Token berubah setiap kali susunan daftarnya berubah. Memakai jumlahnya
    // saja tidak cukup: penyaring dapat membuang satu hotel dan menambah
    // satu lagi tanpa mengubah jumlahnya.
    token: properties.map((property) => property.ref).join(','),
    enabled: anchorEnabled,
  })

  return (
    <div ref={container} className="flex flex-col gap-4">
      {properties.map((property, index) => (
        <PropertyCard
          key={property.ref}
          property={property}
          nights={nights}
          query={query}
          index={index}
        />
      ))}
    </div>
  )
}
