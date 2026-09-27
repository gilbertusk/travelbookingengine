import { describe, expect, test } from 'vitest'
import {
  harness,
  HOLD_DURATION_MS,
  priceCheckRequest,
  USER,
  type Harness,
} from '../testing/fakes.js'
import type { Booking } from '../domain/booking.js'
import { expireHold } from './expire-hold.js'
import { persist } from './persist.js'
import { placeHold, slotOf } from './place-hold.js'
import { startPriceCheck } from './price-check.js'
import { sweepHolds } from './sweep-holds.js'

async function held(world: Harness, key = 'req-2026-10-01-0001'): Promise<Booking> {
  const checked = await startPriceCheck(world.deps, priceCheckRequest({ key }))
  if (checked.kind !== 'checked') throw new Error('persiapan gagal')
  const result = await placeHold(world.deps, {
    userId: USER,
    bookingId: checked.booking.id,
    unitsLeft: 5,
  })
  if (result.kind !== 'held') throw new Error(`persiapan gagal: ${result.kind}`)
  return result.booking
}

function heldEvents(world: Harness, type: string): number {
  return world.db.committed().events.filter((event) => event.eventType === type).length
}

describe('kedaluwarsa hold (FR-16)', () => {
  test('hold yang lewat batas waktunya menjadi EXPIRED dan kursi lokal kembali', async () => {
    const world = harness()
    const booking = await held(world)
    world.advance(HOLD_DURATION_MS)

    const outcome = await expireHold(world.deps, booking.id)

    expect(outcome).toBe('expired')
    expect((await world.deps.bookings.findById(booking.id))?.status).toBe('EXPIRED')
    expect(world.holds.held(slotOf(booking))).toBe(0)
    expect(heldEvents(world, 'HoldExpired')).toBe(1)
  })

  /**
   * Redis mengedaluwarsakan kunci menurut jam Redis; jam mesin ini boleh
   * tertinggal. Kedaluwarsa lebih awal membuat pengguna yang sedang membayar
   * kehilangan kamarnya, jadi yang dipercaya adalah aturan domain.
   */
  test('notifikasi yang tiba sebelum batas waktu menurut jam kita tidak melepas apa pun', async () => {
    const world = harness()
    const booking = await held(world)
    world.advance(HOLD_DURATION_MS - 1)

    const outcome = await expireHold(world.deps, booking.id)

    expect(outcome).toBe('not_due')
    expect((await world.deps.bookings.findById(booking.id))?.status).toBe('HELD')
    expect(world.holds.held(slotOf(booking))).toBe(1)
  })

  test('pemesanan yang sudah dibayar tidak dikedaluwarsakan, kursi lokalnya dilepas', async () => {
    const world = harness()
    const booking = await held(world)
    await persist(world.deps, booking, {
      type: 'recordPayment',
      at: world.now(),
      paymentId: 'c2d4e6f8-0a1b-4c3d-8e5f-6a7b8c9d0e1f',
      amount: booking.price.total,
    })
    world.advance(HOLD_DURATION_MS)

    const outcome = await expireHold(world.deps, booking.id)

    expect(outcome).toBe('already_moved')
    expect((await world.deps.bookings.findById(booking.id))?.status).toBe('PAID')
    expect(world.holds.held(slotOf(booking))).toBe(0)
  })

  test('kunci untuk pemesanan yang tidak dikenal dilaporkan, tanpa galat', async () => {
    const world = harness()

    expect(await expireHold(world.deps, '00000000-0000-4000-8000-00000000ffff')).toBe(
      'unknown_booking',
    )
  })
})

describe('jalur keyspace dan penyapu tidak saling merusak', () => {
  test('keduanya serentak: tepat satu perpindahan ke EXPIRED, kursi kembali tepat sekali', async () => {
    const world = harness()
    const booking = await held(world)
    world.advance(HOLD_DURATION_MS)

    const [keyspace, sweep] = await Promise.all([
      expireHold(world.deps, booking.id),
      sweepHolds(world.deps),
    ])

    expect([keyspace, sweep.due.expired > 0 ? 'expired' : 'already_moved'].sort()).toEqual([
      'already_moved',
      'expired',
    ])
    expect(heldEvents(world, 'HoldExpired')).toBe(1)
    expect(world.holds.held(slotOf(booking))).toBe(0)
  })

  test('penyapu idempoten: putaran kedua tidak mengubah apa pun', async () => {
    const world = harness()
    await held(world)
    world.advance(HOLD_DURATION_MS)

    const first = await sweepHolds(world.deps)
    const second = await sweepHolds(world.deps)

    expect(first.due.expired).toBe(1)
    expect(second).toEqual({
      due: { expired: 0, already_moved: 0, not_due: 0, unknown_booking: 0 },
      orphansReleased: 0,
    })
    expect(heldEvents(world, 'HoldExpired')).toBe(1)
  })
})

describe('penyapu sebagai jaring pengaman', () => {
  test('notifikasi yang hilang: penyapu mengedaluwarsakan hold yang lewat', async () => {
    const world = harness()
    const booking = await held(world)
    world.advance(HOLD_DURATION_MS + 1)

    const report = await sweepHolds(world.deps)

    expect(report.due.expired).toBe(1)
    expect((await world.deps.bookings.findById(booking.id))?.status).toBe('EXPIRED')
  })

  test('hold yang belum lewat tidak disentuh penyapu', async () => {
    const world = harness()
    const booking = await held(world)

    await sweepHolds(world.deps)

    expect((await world.deps.bookings.findById(booking.id))?.status).toBe('HELD')
  })

  /**
   * Proses mati di antara mengambil kursi lokal dan menyimpan pemesanan: kursi
   * dipegang pemesanan yang tidak pernah HELD di basis data. Sumber basis data
   * tidak akan pernah melihatnya — hanya pencarian yatim di Redis.
   */
  test('kursi yatim tanpa pemesanan HELD dikembalikan setelah kunci waktunya hilang', async () => {
    const world = harness()
    const entry = {
      bookingId: '00000000-0000-4000-8000-0000000000aa',
      slot: 'SKY|RP|2026-11-10|2026-11-12',
    }
    await world.deps.holds.acquire({ ...entry, capacity: 1, until: world.now() })
    world.holds.dropLock(entry.bookingId)

    const report = await sweepHolds(world.deps)

    expect(report.orphansReleased).toBe(1)
    expect(world.holds.held(entry.slot)).toBe(0)
  })

  test('kursi yatim milik pemesanan yang masih HELD dibiarkan sampai batas waktunya', async () => {
    const world = harness()
    const booking = await held(world)
    world.holds.dropLock(booking.id)

    const report = await sweepHolds(world.deps)

    expect(report.orphansReleased).toBe(0)
    expect(world.holds.held(slotOf(booking))).toBe(1)
  })

  test('kursi yatim tidak dilepas selama kunci waktunya masih ada', async () => {
    const world = harness()
    const entry = {
      bookingId: '00000000-0000-4000-8000-0000000000bb',
      slot: 'SKY|RP|2026-11-10|2026-11-12',
    }
    await world.deps.holds.acquire({ ...entry, capacity: 1, until: world.now() })

    expect((await sweepHolds(world.deps)).orphansReleased).toBe(0)
  })

  test('penyapu memproses paling banyak satu batch per putaran, yang paling lama lebih dulu', async () => {
    const world = harness()
    const first = await held(world, 'req-2026-10-01-0001')
    world.advance(1_000)
    await held(world, 'req-2026-10-01-0002')
    world.advance(HOLD_DURATION_MS)
    const deps = { ...world.deps, holdPolicy: { ...world.deps.holdPolicy, sweepBatch: 1 } }

    await sweepHolds(deps)

    expect((await world.deps.bookings.findById(first.id))?.status).toBe('EXPIRED')
    expect(heldEvents(world, 'HoldExpired')).toBe(1)
  })
})

describe('persist', () => {
  test('pemesanan yang hilang di tengah transisi adalah galat tak terduga, bukan hasil', async () => {
    const world = harness()
    const booking = await held(world)
    world.db.committed().bookings.delete(booking.id)

    await expect(
      persist(world.deps, booking, {
        type: 'expireHold',
        at: new Date(world.now().getTime() + HOLD_DURATION_MS),
      }),
    ).rejects.toThrow('hilang di tengah transisi expireHold')
  })
})
