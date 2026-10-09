'use client'

import { useInfiniteQuery } from '@tanstack/react-query'
import { AlertTriangle, Luggage } from 'lucide-react'
import Link from 'next/link'
import { EmptyState, ErrorState, LoadingState } from '@/components/state/states'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { fetchBookingsPage } from '@/features/bookings/api'
import { BOOKING_GROUPS, type BookingGroup } from '@/features/bookings/types'
import { humanMessage } from '@/lib/api-error'
import { BookingCard } from './booking-card'

/**
 * Daftar pemesanan (Step 26, FR-25), dikelompokkan: akan datang, selesai,
 * dibatalkan. Setiap kelompok dimuat sendiri, berhalaman.
 *
 * Kartu, bukan tabel, di semua lebar: tabel yang digulir ke samping di layar
 * 375px menyembunyikan status — kolom yang paling penting — di luar layar.
 */

const GROUP_LABELS: Readonly<Record<BookingGroup, string>> = {
  upcoming: 'Akan datang',
  past: 'Selesai',
  cancelled: 'Dibatalkan',
}

const EMPTY_COPY: Readonly<Record<BookingGroup, { title: string; description: string }>> = {
  upcoming: {
    title: 'Belum ada perjalanan yang akan datang',
    description:
      'Pemesanan yang kamu buat akan muncul di sini, lengkap dengan status dan kebijakan pembatalannya.',
  },
  past: {
    title: 'Belum ada perjalanan yang selesai',
    description: 'Pemesanan yang sudah kamu jalani akan tersimpan di sini.',
  },
  cancelled: {
    title: 'Tidak ada pemesanan yang dibatalkan',
    description: 'Pemesanan yang dibatalkan atau tidak selesai akan tercatat di sini.',
  },
}

export function BookingsList() {
  return (
    <Tabs defaultValue="upcoming">
      <TabsList aria-label="Kelompok pemesanan" className="w-full">
        {BOOKING_GROUPS.map((group) => (
          <TabsTrigger key={group} value={group}>
            {GROUP_LABELS[group]}
          </TabsTrigger>
        ))}
      </TabsList>
      {BOOKING_GROUPS.map((group) => (
        <TabsContent key={group} value={group}>
          <GroupList group={group} />
        </TabsContent>
      ))}
    </Tabs>
  )
}

function GroupList({ group }: { readonly group: BookingGroup }) {
  const query = useInfiniteQuery({
    queryKey: ['bookings', group],
    queryFn: async ({ pageParam, signal }) => await fetchBookingsPage(group, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  })

  if (query.isPending) {
    return (
      <LoadingState label="Memuat pemesanan" className="flex flex-col gap-4">
        {[0, 1, 2].map((index) => (
          <Skeleton key={index} className="h-32 w-full" />
        ))}
      </LoadingState>
    )
  }

  if (query.isError) {
    return (
      <ErrorState
        icon={<AlertTriangle />}
        title="Pemesanan belum dapat dimuat"
        description={humanMessage(query.error)}
        action={
          <Button
            variant="secondary"
            onClick={() => {
              void query.refetch()
            }}
          >
            Coba lagi
          </Button>
        }
      />
    )
  }

  const items = query.data.pages.flatMap((page) => page.items)

  if (items.length === 0) {
    return (
      <EmptyState
        icon={<Luggage />}
        title={EMPTY_COPY[group].title}
        description={EMPTY_COPY[group].description}
        action={
          <Button asChild variant="primary">
            <Link href="/cari">Cari penginapan</Link>
          </Button>
        }
      />
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <ul className="flex flex-col gap-4" aria-label={GROUP_LABELS[group]}>
        {items.map((item) => (
          <li key={item.id}>
            <BookingCard item={item} />
          </li>
        ))}
      </ul>

      {query.hasNextPage ? (
        <div className="flex flex-col items-start gap-2">
          <Button
            variant="secondary"
            disabled={query.isFetchingNextPage}
            onClick={() => {
              void query.fetchNextPage()
            }}
          >
            {query.isFetchingNextPage ? 'Memuat…' : 'Muat lebih banyak'}
          </Button>
        </div>
      ) : null}
      <p aria-live="polite" className="sr-only">
        {`${String(items.length)} pemesanan ditampilkan`}
      </p>
    </div>
  )
}
