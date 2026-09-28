import {
  createMessage,
  type EventPayload,
  type EventType,
  type Message,
} from '@tbe/event-contracts'
import { describe, expect, test } from 'vitest'
import { PAYMENT_ID, REFUND_ID, SUPPLIER_REF, sagaWorld } from '../testing/saga-world.js'
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

  test('jenis di luar yang didengarkan tidak diproses', async () => {
    const world = sagaWorld()
    const handle = handleSagaEvent(world.deps)

    expect(await handle(message('supplier.recovered', { supplier: 'SKY' }))).toBe('not_subscribed')
    expect(SAGA_EVENTS).not.toContain('supplier.recovered')
  })
})
