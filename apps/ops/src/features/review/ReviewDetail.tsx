'use client'

import { useQuery } from '@tanstack/react-query'
import { Card, CardContent, CardHeader, CardTitle } from '@tbe/ui/card'
import { z } from 'zod'
import { dateTime, milliseconds, money } from '@/lib/format'
import { opsRequest } from '@/lib/ops-client'
import { supplierRequestSchema } from '../suppliers/schema'
import { REVIEW_CONCERNS, paymentSchema, type ReviewCase } from './schema'

/**
 * Seluruh konteks satu pemesanan yang ditinjau (Step 27): ringkasan dan
 * kekhawatirannya, jejak booking_events, keadaan saga, status pembayaran dari
 * payment-service, dan catatan permintaan ke supplier dari supplier-service.
 * Dua yang terakhir dirangkai DI SINI dari kunci yang diberikan
 * booking-service — booking-service sendiri tidak memanggil service lain
 * untuk halaman operator.
 */
export function ReviewDetail({ item }: { readonly item: ReviewCase }) {
  const { booking } = item

  return (
    <section aria-label={`Konteks pemesanan ${booking.id}`} className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Ringkasan</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1 text-small">
          {booking.review !== null && (
            <p className="font-medium">
              {REVIEW_CONCERNS[booking.review.from] ?? booking.review.from}
            </p>
          )}
          <p>Alasan: {booking.review?.reason ?? booking.failureReason ?? '—'}</p>
          <p>
            Tamu: {booking.leadGuest.fullName} ({booking.leadGuest.email})
          </p>
          <p>
            {booking.city} · {booking.checkIn} → {booking.checkOut} · {booking.guests} tamu
          </p>
          <p>Nilai: {money(booking.price.total)}</p>
          <p>Booking reference: {booking.supplierRef ?? '—'}</p>
          <p>
            Saga:{' '}
            {item.saga === null
              ? '—'
              : `${item.saga.phase} di langkah ${item.saga.step}, ${String(item.saga.attempts)} percobaan` +
                (item.saga.lastError === null ? '' : `, galat terakhir: ${item.saga.lastError}`)}
          </p>
          <PaymentStatus paymentId={booking.paymentId} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Jejak booking_events</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="flex flex-col gap-1 text-small">
            {item.trail.map((entry) => (
              <li key={entry.sequence}>
                <span className="text-muted-foreground" data-numeric>
                  #{entry.sequence} · {dateTime(entry.occurredAt)}
                </span>{' '}
                <span className="font-medium">{entry.type}</span>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
      <SupplierRequests idempotencyKey={item.supplierIdempotencyKey} />
    </section>
  )
}

function PaymentStatus({ paymentId }: { readonly paymentId: string | null }) {
  const payment = useQuery({
    queryKey: ['ops', 'payment', paymentId],
    queryFn: async () => await opsRequest(paymentSchema, 'GET', `/payments/${String(paymentId)}`),
    enabled: paymentId !== null,
  })

  if (paymentId === null) return <p>Pembayaran: —</p>
  if (payment.isError)
    return <p className="text-destructive">Pembayaran: {payment.error.message}</p>
  if (payment.data === undefined) return <p>Pembayaran: memuat…</p>
  return (
    <p>
      Pembayaran: <span className="font-medium">{payment.data.payment.status}</span> ·{' '}
      {money(payment.data.payment.amount)}
      {(payment.data.payment.refunds ?? []).map((refund, index) => (
        <span key={index}>
          {' '}
          · refund {refund.status} {money(refund.amount)}
        </span>
      ))}
    </p>
  )
}

function SupplierRequests({ idempotencyKey }: { readonly idempotencyKey: string }) {
  const requests = useQuery({
    queryKey: ['ops', 'supplier-requests', idempotencyKey],
    queryFn: async () =>
      await opsRequest(
        z.array(supplierRequestSchema),
        'GET',
        `/suppliers/requests?idempotencyKey=${encodeURIComponent(idempotencyKey)}`,
      ),
  })

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle>Catatan permintaan supplier</CardTitle>
      </CardHeader>
      <CardContent className="text-small">
        {requests.isError && <p className="text-destructive">{requests.error.message}</p>}
        {requests.data?.length === 0 && (
          <p className="text-muted-foreground">Tidak ada permintaan tercatat untuk kunci ini.</p>
        )}
        <ol className="flex flex-col gap-2">
          {requests.data?.map((request) => (
            <li key={request.id}>
              <span className="font-medium">
                {request.operation} #{request.attemptNumber}
              </span>{' '}
              {request.outcome === 'success' ? 'berhasil' : `gagal (${request.errorKind ?? '?'})`} ·{' '}
              {milliseconds(request.latencyMs)} · {dateTime(request.createdAt)}
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  )
}
