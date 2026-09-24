import { Suspense } from 'react'
import type { Metadata } from 'next'
import { SearchResults } from '@/components/search/search-results'
import { ResultsSkeleton } from '@/components/search/property-card-skeleton'

export const metadata: Metadata = {
  title: 'Hasil pencarian',
  description: 'Bandingkan harga hotel dari beberapa penyedia sekaligus.',
}

/**
 * Halaman hasil pencarian.
 *
 * Kerangkanya dirender di server; isinya klien, karena hasil pencarian
 * bergantung pada kriteria di URL dan diperbarui bertahap saat penyedia
 * lambat menjawab.
 *
 * `Suspense` wajib di sini, bukan pilihan: `useSearchParams` di dalam
 * komponen klien memaksa seluruh halaman menjadi render dinamis kecuali ia
 * dibungkus batas Suspense. Tanpa itu, build Next gagal dengan pesan yang
 * tidak menyebutkan penyebabnya.
 */
export default function SearchPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-content px-4 py-8 sm:px-6">
          <ResultsSkeleton />
        </div>
      }
    >
      <SearchResults />
    </Suspense>
  )
}
