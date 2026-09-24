'use client'

import { AlertTriangle, SearchX, SlidersHorizontal } from 'lucide-react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { EmptyState, ErrorState } from '@/components/state/states'
import { humanMessage } from '@/lib/api-error'
import { parseCriteria, searchHref, type SearchCriteria } from '@/features/search/criteria'
import { useSearch } from '@/features/search/use-search'
import { FilterChips, FiltersPanel } from './filters-panel'
import { PartialResultNotice } from './partial-result-notice'
import { ResultsSkeleton } from './property-card-skeleton'
import { ResultsList } from './results-list'
import { SearchBar } from './search-bar'
import { SortSelect } from './sort-select'

/**
 * Halaman hasil pencarian.
 *
 * Lima keadaan, seluruhnya wajib — DESIGN-SYSTEM.md bagian 7:
 *
 *   belum mencari → formulir, bukan daftar kosong
 *   memuat        → skeleton berbentuk kartu, bukan spinner
 *   parsial       → daftar YANG SUDAH ADA plus keterangan sisanya
 *   kosong        → penjelasan dan saran mengubah kriteria
 *   galat         → penjelasan manusiawi dan tombol coba lagi
 *
 * Urutan pemeriksaannya punya satu keputusan yang mudah salah: **data yang
 * sudah ada menang atas galat**. Pengambilan ulang yang gagal — misalnya
 * setelah mengubah penyaring — tidak boleh mengosongkan layar. Hasil yang
 * sudah dibaca pengguna hilang begitu saja karena satu permintaan latar
 * belakang gagal adalah kerugian yang jauh lebih besar daripada tidak tahu
 * bahwa permintaan itu gagal.
 */

export function SearchResults() {
  const router = useRouter()
  const params = useSearchParams()
  const [filtersOpen, setFiltersOpen] = useState(false)

  const criteria = useMemo(() => parseCriteria(new URLSearchParams(params.toString())), [params])

  const { data, isLoading, isFetching, isPlaceholderData, error, refetch } = useSearch(criteria)

  function apply(next: SearchCriteria): void {
    // `replace`, bukan `push`. Mengubah penyaring lima kali lalu menekan
    // tombol kembali seharusnya mengembalikan pengguna ke halaman sebelumnya,
    // bukan menelusuri lima keadaan penyaring satu per satu.
    router.replace(searchHref(next), { scroll: false })
    setFiltersOpen(false)
  }

  if (criteria === undefined) {
    return (
      <div className="mx-auto flex max-w-content flex-col gap-8 px-4 py-12 sm:px-6">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">Mau menginap di mana?</h1>
          <p className="text-sm text-muted-foreground">
            Isi tujuan dan tanggal menginap untuk melihat harga dari beberapa penyedia sekaligus.
          </p>
        </div>
        <SearchBar />
      </div>
    )
  }

  return (
    <div className="mx-auto flex max-w-content flex-col gap-6 px-4 py-8 sm:px-6">
      <SearchBar initial={criteria} compact />

      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        <aside className="hidden w-[260px] shrink-0 lg:block">
          <FiltersPanel criteria={criteria} onChange={apply} />
        </aside>

        <main className="flex min-w-0 flex-1 flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <h1 className="text-lg font-medium tracking-tight">
              Hotel di {criteria.city}
              {data === undefined ? null : (
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  {data.properties.length} pilihan
                </span>
              )}
            </h1>

            <div className="flex items-center gap-3">
              <Sheet open={filtersOpen} onOpenChange={setFiltersOpen}>
                <SheetTrigger asChild>
                  <Button variant="secondary" size="sm" className="lg:hidden">
                    <SlidersHorizontal />
                    Penyaring
                  </Button>
                </SheetTrigger>
                <SheetContent side="bottom" className="max-h-[85vh] overflow-auto">
                  <SheetHeader>
                    <SheetTitle>Penyaring</SheetTitle>
                  </SheetHeader>
                  <FiltersPanel criteria={criteria} onChange={apply} className="px-4 pb-8" />
                </SheetContent>
              </Sheet>

              <SortSelect criteria={criteria} onChange={apply} />
            </div>
          </div>

          <FilterChips criteria={criteria} onChange={apply} />

          {data === undefined ? null : (
            <PartialResultNotice meta={data.meta} isRefreshing={isFetching && isPlaceholderData} />
          )}

          <Body
            data={data}
            isLoading={isLoading}
            isPlaceholderData={isPlaceholderData}
            error={error}
            criteria={criteria}
            onRetry={() => {
              void refetch()
            }}
            onClearFilters={() => {
              apply({
                ...criteria,
                minStarRating: undefined,
                maxTotalMinor: undefined,
                amenities: [],
                refundableOnly: false,
                breakfastIncluded: false,
              })
            }}
          />
        </main>
      </div>
    </div>
  )
}

function Body({
  data,
  isLoading,
  isPlaceholderData,
  error,
  criteria,
  onRetry,
  onClearFilters,
}: {
  readonly data: ReturnType<typeof useSearch>['data']
  readonly isLoading: boolean
  readonly isPlaceholderData: boolean
  readonly error: unknown
  readonly criteria: SearchCriteria
  readonly onRetry: () => void
  readonly onClearFilters: () => void
}) {
  if (data !== undefined) {
    if (data.properties.length === 0) {
      return (
        <EmptyState
          icon={<SearchX />}
          title="Tidak ada yang cocok"
          description="Coba longgarkan penyaringnya, ubah tanggal, atau cari di kota terdekat."
          action={
            <Button variant="secondary" onClick={onClearFilters}>
              Hapus semua penyaring
            </Button>
          }
        />
      )
    }

    return (
      <ResultsList
        properties={data.properties}
        criteria={criteria}
        // Penjangkaran dimatikan saat daftar yang terlihat masih milik
        // pencarian sebelumnya — belum ada yang dibaca pengguna di daftar ini.
        anchorEnabled={!isPlaceholderData}
      />
    )
  }

  if (isLoading) {
    return (
      <div aria-busy="true" aria-live="polite">
        <span className="sr-only">Mencari hotel</span>
        <ResultsSkeleton />
      </div>
    )
  }

  if (error !== null && error !== undefined) {
    return (
      <ErrorState
        icon={<AlertTriangle />}
        title="Pencarian gagal"
        description={humanMessage(error)}
        action={
          <Button variant="secondary" onClick={onRetry}>
            Coba lagi
          </Button>
        }
      />
    )
  }

  return <ResultsSkeleton />
}
