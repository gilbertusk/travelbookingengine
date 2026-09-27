import { describe, expect, test } from 'vitest'
import { harness, HOLD_DURATION_MS, priceCheckRequest, USER } from '../testing/fakes.js'
import { placeHold } from '../application/place-hold.js'
import { startPriceCheck } from '../application/price-check.js'
import { holdSweeper } from './app.js'

async function until(condition: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await condition()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('kondisi tidak pernah terpenuhi')
}

describe('penyapu hold terkelola', () => {
  test('berjalan berkala dan melepas hold yang lewat tanpa dipanggil siapa pun', async () => {
    const world = harness()
    const checked = await startPriceCheck(world.deps, priceCheckRequest())
    if (checked.kind !== 'checked') throw new Error('persiapan gagal')
    await placeHold(world.deps, { userId: USER, bookingId: checked.booking.id, unitsLeft: 1 })
    world.advance(HOLD_DURATION_MS)
    const sweeper = holdSweeper(world.deps, 5)

    await sweeper.start?.()
    await until(
      async () => (await world.deps.bookings.findById(checked.booking.id))?.status === 'EXPIRED',
    )
    await sweeper.stop()
  })

  test('putaran yang gagal tidak menghentikan putaran berikutnya', async () => {
    const world = harness()
    let calls = 0
    const deps = {
      ...world.deps,
      bookings: {
        ...world.deps.bookings,
        findExpiredHolds: async () => {
          calls += 1
          if (calls === 1) throw new Error('basis data sesaat tidak dapat dihubungi')
          return await Promise.resolve([])
        },
      },
    }
    const sweeper = holdSweeper(deps, 5)

    await sweeper.start?.()
    await until(async () => await Promise.resolve(calls >= 3))
    await sweeper.stop()

    expect(calls).toBeGreaterThanOrEqual(3)
  })

  test('berhenti di tengah putaran menunggu putaran itu selesai dan tidak menjadwalkan yang baru', async () => {
    const world = harness()
    let calls = 0
    let finish: () => void = () => undefined
    const deps = {
      ...world.deps,
      bookings: {
        ...world.deps.bookings,
        findExpiredHolds: async () => {
          calls += 1
          await new Promise<void>((resolve) => {
            finish = resolve
          })
          return []
        },
      },
    }
    const sweeper = holdSweeper(deps, 5)
    await sweeper.start?.()
    await until(async () => await Promise.resolve(calls === 1))

    const stopping = sweeper.stop()
    finish()
    await stopping
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(calls).toBe(1)
  })

  test('berhenti berarti tidak ada putaran baru', async () => {
    const world = harness()
    let calls = 0
    const deps = {
      ...world.deps,
      bookings: {
        ...world.deps.bookings,
        findExpiredHolds: async () => {
          calls += 1
          return await Promise.resolve([])
        },
      },
    }
    const sweeper = holdSweeper(deps, 5)
    await sweeper.start?.()
    await until(async () => await Promise.resolve(calls >= 1))

    await sweeper.stop()
    const stoppedAt = calls
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(calls).toBe(stoppedAt)
  })
})
