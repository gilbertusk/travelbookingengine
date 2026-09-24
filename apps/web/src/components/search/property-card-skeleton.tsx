import { Skeleton } from '@/components/ui/skeleton'

/**
 * Skeleton yang MENYERUPAI bentuk akhirnya.
 *
 * DESIGN-SYSTEM.md bagian 7 melarang spinner di tengah layar, dan alasannya
 * bukan selera: skeleton yang bentuknya sama dengan hasil akhir membuat tata
 * letak halaman sudah terbentuk penuh sebelum data sampai. Tidak ada yang
 * bergeser saat kartu sungguhan menggantikannya — dan pergeseran itulah yang
 * diukur CLS.
 *
 * Ukurannya karena itu disalin dari PropertyCard, bukan dikira-kira.
 */
export function PropertyCardSkeleton() {
  return (
    <div className="grid gap-4 rounded-xl border border-border bg-card p-4 sm:grid-cols-[13rem_1fr]">
      <Skeleton className="aspect-[4/3] w-full rounded-lg" />

      <div className="flex flex-col gap-4 sm:flex-row sm:justify-between">
        <div className="flex flex-col gap-3">
          <Skeleton className="h-5 w-64 max-w-full" />
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-52" />
        </div>

        <div className="flex flex-col items-end gap-2">
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-4 w-24" />
        </div>
      </div>
    </div>
  )
}

export function ResultsSkeleton({ count = 6 }: { readonly count?: number }) {
  return (
    <div className="flex flex-col gap-4">
      {Array.from({ length: count }, (_unused, index) => (
        <PropertyCardSkeleton key={index} />
      ))}
    </div>
  )
}
