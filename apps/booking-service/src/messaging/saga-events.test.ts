import {
  createMessage,
  type EventPayload,
  type EventType,
  type Message,
} from '@tbe/event-contracts'
import { describe, expect, test } from 'vitest'
import { PAYMENT_ID, REFUND_ID, SUPPLIER_REF, sagaWorld } from '../testing/saga-world.js'
import { cancellationRefundRequestId } from '../application/cancellation/commands.js'
import { cancellationWorld } from '../testing/cancellation-world.js'
import { handleSagaEvent, SAGA_EVENTS } from './saga-events.js'

/**
 * Terjemahan pesan kontrak ke reaksi saga. Keputusannya diuji di
 * application/saga; yang diuji di sini hanya bahwa setiap jenis yang
 * didengarkan sampai ke reaksinya, dengan eventId amplop sebagai pengenal
 * pesan terkonsumsi.
 */

function message<T extends EventType>(
  type: T,
  payload: EventPayload<T>,
): Message<EventType, EventPayload<EventType>> {
  return createMessage({ eventType: type, payload })
}

describe('consumer peristiwa saga', () => {
  test('alur lengkap lewat pesan kontrak: sampai REFUNDED', async () => {
    const world = sagaWorld()
    const held = await world.held()
    const handle = handleSagaEvent(world.deps)
    const amount = { amountMinor: held.price.total.amountMinor, currency: 'IDR' as const }

    await handle(
      message('payment.succeeded', {
        paymentId: PAYMENT_ID,
        bookingId: held.id,
        amount,
        gatewayRef: 'MID-1',
      }),
    )
    await handle(
      message('supplier.booking_rejected', {
        bookingId: held.id,
        supplier: 'SKY',
        reason: 'sold_out',
      }),
    )
    await handle(
      message('payment.refunded', {
        refundId: REFUND_ID,
        paymentId: PAYMENT_ID,
        bookingId: held.id,
        amount,
      }),
    )

    expect(await world.booking(held.id)).toMatchObject({ status: 'REFUNDED' })
  })

  test('konfirmasi, penolakan pembayaran, dan ketidakpastian sampai ke reaksinya', async () => {
    const world = sagaWorld()
    const handle = handleSagaEvent(world.deps)
    const confirmed = await world.paid('req-2026-10-01-0001')
    const uncertain = await world.paid('req-2026-10-01-0002')
    const failed = await world.held('req-2026-10-01-0003')

    await handle(
      message('supplier.booking_confirmed', {
        bookingId: confirmed.id,
        supplier: 'SKY',
        supplierRef: SUPPLIER_REF,
        adopted: false,
      }),
    )
    await handle(
      message('supplier.booking_uncertain', {
        bookingId: uncertain.id,
        supplier: 'SKY',
        idempotencyKey: uncertain.id,
        reason: 'timeout',
      }),
    )
    await handle(
      message('payment.failed', { paymentId: PAYMENT_ID, bookingId: failed.id, reason: 'ditolak' }),
    )

    expect((await world.booking(confirmed.id)).status).toBe('CONFIRMED')
    expect((await world.booking(uncertain.id)).status).toBe('NEEDS_REVIEW')
    expect((await world.booking(failed.id)).status).toBe('CANCELLED')
  })

  test('pesan yang sama dua kali: reaksi kedua dilaporkan duplikat', async () => {
    const world = sagaWorld()
    const held = await world.held()
    const handle = handleSagaEvent(world.deps)
    const amount = { amountMinor: held.price.total.amountMinor, currency: 'IDR' as const }
    const once = message('payment.succeeded', {
      paymentId: PAYMENT_ID,
      bookingId: held.id,
      amount,
      gatewayRef: 'MID-1',
    })

    expect(await handle(once)).toBe('applied')
    expect(await handle(once)).toBe('duplicate')
  })

  test('jawaban atas pembatalan sampai ke reaksinya (Step 25)', async () => {
    const world = cancellationWorld()
    const handle = handleSagaEvent(world.deps)
    const refunded = await world.confirmed('req-2026-10-01-0001')
    const restored = await world.confirmed('req-2026-10-01-0002')
    const reviewed = await world.confirmed('req-2026-10-01-0003')
    for (const booking of [refunded, restored, reviewed]) await world.cancel(booking)
    const cancelledReply = (bookingId: string) =>
      message('supplier.booking_cancelled', {
        bookingId,
        supplier: 'SKY',
        supplierRef: SUPPLIER_REF,
      })

    await handle(cancelledReply(refunded.id))
    await handle(
      message('supplier.booking_cancel_failed', {
        bookingId: restored.id,
        supplier: 'SKY',
        supplierRef: SUPPLIER_REF,
        outcome: 'refused',
        reason: 'upstream_error:409',
      }),
    )
    await handle(cancelledReply(reviewed.id))
    await handle(
      message('payment.refund_failed', {
        refundRequestId: cancellationRefundRequestId(reviewed.id, PAYMENT_ID),
        paymentId: PAYMENT_ID,
        bookingId: reviewed.id,
        amount: { amountMinor: 2_442_000, currency: 'IDR' },
        reason: 'gateway_rejected',
      }),
    )

    expect((await world.booking(refunded.id)).status).toBe('CANCELLING')
    expect((await world.booking(restored.id)).status).toBe('CONFIRMED')
    expect((await world.booking(reviewed.id)).status).toBe('NEEDS_REVIEW')
  })

  test('jenis di luar yang didengarkan tidak diproses', async () => {
    const world = sagaWorld()
    const handle = handleSagaEvent(world.deps)

    expect(await handle(message('supplier.recovered', { supplier: 'SKY' }))).toBe('not_subscribed')
    expect(SAGA_EVENTS).not.toContain('supplier.recovered')
  })
})
