import { describe, expect, test } from 'vitest'
import { applyCommand } from '../domain/transitions.js'
import { minutesAfter, T0, validCommand } from '../testing/builders.js'
import { harness, type Harness } from '../testing/fakes.js'
import { storedBooking } from '../testing/stored.js'
import { sweepAbandoned, type AbandonPolicy } from './sweep-abandoned.js'

const DAY_MS = 24 * 60 * 60 * 1_000
const POLICY: AbandonPolicy = { afterMs: DAY_MS, batch: 50 }

async function statusOf(world: Harness, id: string) {
  const booking = await world.deps.bookings.findById(id)
  return booking?.status === 'CANCELLED'
    ? `${booking.status}:${booking.cancellation}`
    : booking?.status
}

describe('penyapu pemesanan yang ditinggalkan (Step 28)', () => {
  test('DRAFT dan PRICE_CHECKED yang tidak disentuh sehari dibatalkan sebagai abandoned', async () => {
    const world = harness({ clock: { value: T0 } })
    const left = await storedBooking(world, '1')
    const checked = await storedBooking(world, '2', 'verifyPrice')
    world.advance(DAY_MS + 60_000)

    const report = await sweepAbandoned(world.deps, POLICY)

    expect(report).toEqual({ abandoned: 2, superseded: 0 })
    expect(await statusOf(world, left.id)).toBe('CANCELLED:abandoned')
    expect(await statusOf(world, checked.id)).toBe('CANCELLED:abandoned')
  })

  test('peristiwa booking.cancelled terbit lewat outbox dengan alasan abandoned', async () => {
    const world = harness({ clock: { value: T0 } })
    const left = await storedBooking(world, '1')
    world.advance(DAY_MS)

    await sweepAbandoned(world.deps, POLICY)

    const cancelled = world.db
      .committed()
      .outbox.filter((row) => row.messageType === 'booking.cancelled')
    expect(cancelled.map((row) => row.payload)).toEqual([
      expect.objectContaining({ bookingId: left.id, reason: 'abandoned' }),
    ])
  })

  test('yang disentuh lebih baru dari batasnya tidak diganggu — batasnya diukur dari perubahan terakhir', async () => {
    const world = harness({ clock: { value: T0 } })
    // Dibuat di T0, price check terakhir satu menit kemudian: updatedAt T0+1m.
    const active = await storedBooking(world, '1', 'verifyPrice')
    world.advance(DAY_MS)

    const report = await sweepAbandoned(world.deps, POLICY)

    expect(report.abandoned).toBe(0)
    expect(await statusOf(world, active.id)).toBe('PRICE_CHECKED')
  })

  test('tepat pada batasnya sudah ditinggalkan: batasnya termasuk, seperti penyapu hold', async () => {
    const world = harness({ clock: { value: T0 } })
    const left = await storedBooking(world, '1')
    world.advance(DAY_MS)

    await sweepAbandoned(world.deps, POLICY)

    expect(await statusOf(world, left.id)).toBe('CANCELLED:abandoned')
  })

  test('keadaan sesudah pra-hold tidak disentuh, berapa pun umurnya', async () => {
    const world = harness({ clock: { value: T0 } })
    const held = await storedBooking(world, '1', 'verifyPrice', 'hold')
    const expired = await storedBooking(world, '2', 'verifyPrice', 'hold', 'expireHold')
    world.advance(30 * DAY_MS)

    const report = await sweepAbandoned(world.deps, POLICY)

    expect(report.abandoned).toBe(0)
    expect(await statusOf(world, held.id)).toBe('HELD')
    expect(await statusOf(world, expired.id)).toBe('EXPIRED')
  })

  test('satu putaran dibatasi batch, yang paling lama lebih dulu', async () => {
    const world = harness({ clock: { value: T0 } })
    const newest = await storedBooking(world, '1', 'verifyPrice', 'verifyPrice')
    const oldest = await storedBooking(world, '2')
    const middle = await storedBooking(world, '3', 'verifyPrice')
    world.advance(2 * DAY_MS)

    const report = await sweepAbandoned(world.deps, { ...POLICY, batch: 2 })

    expect(report.abandoned).toBe(2)
    expect(await statusOf(world, oldest.id)).toBe('CANCELLED:abandoned')
    expect(await statusOf(world, middle.id)).toBe('CANCELLED:abandoned')
    expect(await statusOf(world, newest.id)).toBe('PRICE_CHECKED')
  })

  test('pengguna yang kembali di antara dibaca dan dibatalkan menang', async () => {
    const world = harness({ clock: { value: T0 } })
    const left = await storedBooking(world, '1')
    world.advance(DAY_MS)
    // Penyapu membaca DRAFT; sebelum ia menyimpan, pengguna memeriksa harga.
    const repository = world.deps.bookings
    const deps = {
      ...world.deps,
      bookings: {
        ...repository,
        findAbandoned: async (before: Date, limit: number) => {
          const snapshot = await repository.findAbandoned(before, limit)
          const moved = applyCommand(left, validCommand(left, 'verifyPrice'))
          if (!moved.ok) throw moved.error
          await repository.save(moved.value)
          return snapshot
        },
      },
    }

    const report = await sweepAbandoned(deps, POLICY)

    expect(report).toEqual({ abandoned: 0, superseded: 1 })
    expect(await statusOf(world, left.id)).toBe('PRICE_CHECKED')
  })

  test('HELD dari repository ditolak sebelum disentuh — domain sendiri mengizinkan cancel pada HELD', async () => {
    const world = harness({ clock: { value: T0 } })
    const held = await storedBooking(world, '1', 'verifyPrice', 'hold')
    world.advance(DAY_MS)
    const deps = {
      ...world.deps,
      bookings: {
        ...world.deps.bookings,
        findAbandoned: async () => await Promise.resolve([held]),
      },
    }

    await expect(sweepAbandoned(deps, POLICY)).rejects.toThrow(/menerima HELD/)
    expect(await statusOf(world, held.id)).toBe('HELD')
  })

  test('jam penyapu menjadi waktu pembatalan', async () => {
    const world = harness({ clock: { value: T0 } })
    const left = await storedBooking(world, '1')
    world.advance(DAY_MS)

    await sweepAbandoned(world.deps, POLICY)

    const after = await world.deps.bookings.findById(left.id)
    expect(after?.updatedAt).toEqual(minutesAfter(T0, 24 * 60))
  })
})
