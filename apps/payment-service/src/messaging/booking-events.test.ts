import {
  createMessage,
  type EventPayload,
  type EventType,
  type Message,
} from '@tbe/event-contracts'
import { money } from '@tbe/money'
import { describe, expect, test } from 'vitest'
import { createPaymentIntent } from '../application/create-payment-intent.js'
import { TEST_BOOKING_ID, harness } from '../testing/fakes.js'
import { handleBookingEvent } from './booking-events.js'

type AnyMessage = Message<EventType, EventPayload<EventType>>

function created(amountMinor: number, occurredAt: string): AnyMessage {
  return createMessage({
    eventType: 'booking.created' as const,
    occurredAt,
    payload: {
      bookingId: TEST_BOOKING_ID,
      userId: '55555555-5555-4555-8555-555555555555',
      supplier: 'SKY',
      propertyId: 'prop-1',
      ratePlanRef: 'rate-1',
      checkIn: '2026-11-10',
      checkOut: '2026-11-12',
      guests: 2,
      amount: { amountMinor, currency: 'IDR' },
    },
  })
}

function priceChanged(previousMinor: number, newMinor: number, occurredAt: string): AnyMessage {
  return createMessage({
    eventType: 'booking.price_changed' as const,
    occurredAt,
    payload: {
      bookingId: TEST_BOOKING_ID,
      previousAmount: { amountMinor: previousMinor, currency: 'IDR' },
      newAmount: { amountMinor: newMinor, currency: 'IDR' },
    },
  })
}

describe('booking.created', () => {
  test('nilai pemesanan dicatat sebagai nilai yang boleh ditagih', async () => {
    const world = harness()
    world.payables.rows.clear()

    await handleBookingEvent(world.deps)(created(900_000, '2026-09-25T01:00:00.000Z'))

    expect(world.payables.rows.get(TEST_BOOKING_ID)).toMatchObject({
      amount: money(900_000, 'IDR'),
      source: 'booking.created',
    })
  })
})

describe('booking.price_changed', () => {
  test('nilai BARU yang dicatat, bukan nilai sebelumnya', async () => {
    const world = harness()
    world.payables.rows.clear()
    const handle = handleBookingEvent(world.deps)

    await handle(created(900_000, '2026-09-25T01:00:00.000Z'))
    await handle(priceChanged(900_000, 1_100_000, '2026-09-25T01:30:00.000Z'))

    // Memakai previousAmount akan menagih harga yang persis ditinggalkan
    // pengguna — dan itu G2 yang dilanggar dengan cara yang paling halus.
    expect(world.payables.rows.get(TEST_BOOKING_ID)).toMatchObject({
      amount: money(1_100_000, 'IDR'),
      source: 'booking.price_changed',
    })
  })

  test('perubahan harga kedua menimpa yang pertama', async () => {
    const world = harness()
    world.payables.rows.clear()
    const handle = handleBookingEvent(world.deps)

    await handle(priceChanged(900_000, 1_100_000, '2026-09-25T01:30:00.000Z'))
    await handle(priceChanged(1_100_000, 1_250_000, '2026-09-25T01:45:00.000Z'))

    // Harga bisa berubah lagi setelah pengguna menyetujui yang kedua, dan sistem
    // harus tahan terhadap itu — lihat FR-14.
    expect(world.payables.rows.get(TEST_BOOKING_ID)?.amount).toEqual(money(1_250_000, 'IDR'))
  })

  /**
   * Kafka menjamin urutan di dalam satu partisi, dan seluruh peristiwa satu
   * pemesanan berkunci bookingId. Yang tidak dijaminnya adalah urutan setelah
   * consumer digandakan dan satu di antaranya tersendat lalu mengejar.
   */
  test('peristiwa yang lebih lama tidak menimpa yang lebih baru', async () => {
    const world = harness()
    world.payables.rows.clear()
    const handle = handleBookingEvent(world.deps)

    await handle(priceChanged(900_000, 1_100_000, '2026-09-25T01:30:00.000Z'))
    await handle(created(900_000, '2026-09-25T01:00:00.000Z'))

    expect(world.payables.rows.get(TEST_BOOKING_ID)?.amount).toEqual(money(1_100_000, 'IDR'))
  })
})

describe('peristiwa lain pada topik yang sama', () => {
  test('booking.confirmed tidak mengubah apa pun', async () => {
    const world = harness()
    world.payables.rows.clear()

    await handleBookingEvent(world.deps)(
      createMessage({
        eventType: 'booking.confirmed' as const,
        payload: { bookingId: TEST_BOOKING_ID, supplier: 'SKY', supplierRef: 'SKY-1' },
      }),
    )

    expect(world.payables.rows.size).toBe(0)
  })

  test('booking.cancelled dengan refundAmount tidak dianggap nilai tagihan', async () => {
    const world = harness()
    world.payables.rows.clear()

    await handleBookingEvent(world.deps)(
      createMessage({
        eventType: 'booking.cancelled' as const,
        payload: {
          bookingId: TEST_BOOKING_ID,
          reason: 'user_request',
          refundAmount: { amountMinor: 500_000, currency: 'IDR' },
        },
      }),
    )

    // Payload ini juga punya bidang bernilai uang. Penyempitan yang hanya
    // melihat ada-tidaknya bidang uang akan menagih nilai refund sebagai tagihan.
    expect(world.payables.rows.size).toBe(0)
  })
})

describe('bersama pembuatan maksud pembayaran', () => {
  /**
   * G2 dari ujung ke ujung: setelah harga berubah, nilai LAMA tidak dapat lagi
   * ditagih — meski pemanggil masih mengirimkannya.
   */
  test('harga yang sudah berubah membuat nilai lama tidak dapat ditagih', async () => {
    const world = harness()
    world.payables.rows.clear()
    const handle = handleBookingEvent(world.deps)

    await handle(created(900_000, '2026-09-25T01:00:00.000Z'))
    await handle(priceChanged(900_000, 1_100_000, '2026-09-25T01:30:00.000Z'))

    const stale = await createPaymentIntent(world.deps, {
      bookingId: TEST_BOOKING_ID,
      idempotencyKey: 'bkg-1:attempt-1',
      amount: money(900_000, 'IDR'),
    })

    expect(stale.kind).toBe('rejected')
    if (stale.kind !== 'rejected') return
    expect(stale.why).toBe('amount_not_approved')

    const fresh = await createPaymentIntent(world.deps, {
      bookingId: TEST_BOOKING_ID,
      idempotencyKey: 'bkg-1:attempt-1',
      amount: money(1_100_000, 'IDR'),
    })

    expect(fresh.kind).toBe('created')
    expect(world.gateway.charges[0]?.amount).toEqual(money(1_100_000, 'IDR'))
  })
})
