'use client'

import { useQuery } from '@tanstack/react-query'
import { Alert, AlertDescription } from '@tbe/ui/alert'
import { Button } from '@tbe/ui/button'
import { useState } from 'react'
import { dateTime, money } from '@/lib/format'
import { opsRequest } from '@/lib/ops-client'
import { ReviewDetail } from './ReviewDetail'
import { reviewQueueSchema } from './schema'

/**
 * Antrean NEEDS_REVIEW. Yang paling lama menunggu di atas — urutan dari
 * booking-service, bukan disusun ulang di sini.
 */
export function ReviewQueue() {
  const queue = useQuery({
    queryKey: ['ops', 'review'],
    queryFn: async () => await opsRequest(reviewQueueSchema, 'GET', '/bookings/review'),
    refetchInterval: 15_000,
  })
  const [selected, setSelected] = useState<string | undefined>(undefined)

  if (queue.isError) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{queue.error.message}</AlertDescription>
      </Alert>
    )
  }
  if (queue.data === undefined) return <p className="text-muted-foreground">Memuat…</p>
  if (queue.data.length === 0) {
    return <p className="text-muted-foreground">Tidak ada pemesanan yang menunggu tinjauan.</p>
  }

  const current = queue.data.find((item) => item.booking.id === selected)

  return (
    <div className="flex flex-col gap-6">
      <table className="w-full text-small">
        <caption className="sr-only">Pemesanan yang menunggu tinjauan</caption>
        <thead className="text-left text-muted-foreground">
          <tr>
            <th className="p-2">Menunggu sejak</th>
            <th className="p-2">Pemesanan</th>
            <th className="p-2">Supplier</th>
            <th className="p-2">Asal</th>
            <th className="p-2">Nilai</th>
            <th className="p-2">
              <span className="sr-only">Aksi</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {queue.data.map((item) => (
            <tr key={item.booking.id} className="border-t">
              <td className="p-2">{dateTime(item.booking.updatedAt)}</td>
              <td className="p-2 font-mono text-caption">{item.booking.id}</td>
              <td className="p-2">{item.booking.supplier}</td>
              <td className="p-2">{item.booking.review?.from ?? '—'}</td>
              <td className="p-2" data-numeric>
                {money(item.booking.price.total)}
              </td>
              <td className="p-2">
                <Button
                  size="sm"
                  variant={item.booking.id === selected ? 'primary' : 'secondary'}
                  onClick={() => {
                    setSelected(item.booking.id)
                  }}
                >
                  Lihat konteks
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {current !== undefined && <ReviewDetail item={current} />}
    </div>
  )
}
