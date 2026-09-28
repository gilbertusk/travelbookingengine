import { describe, expect, test } from 'vitest'
import { OTHER_USER, USER } from '../testing/fakes.js'
import { sagaWorld } from '../testing/saga-world.js'
import { bookingStatus, isSettled, watchStatus, type StatusSnapshot } from './booking-status.js'

/**
 * Aliran status untuk layar tunggu (FR-26). Yang dijaga: setiap perubahan
 * terpancar tepat sekali, aliran berhenti saat pemesanan tuntas, dan berhenti
 * juga saat penonton pergi.
 */

/** Tidur yang tidak menunggu apa pun: penonton uji tidak perlu jam sungguhan. */
async function noPause(): Promise<void> {
  await Promise.resolve()
}

async function collect(stream: AsyncGenerator<StatusSnapshot>): Promise<StatusSnapshot[]> {
  const seen: StatusSnapshot[] = []
  for await (const snapshot of stream) seen.push(snapshot)
  return seen
}

describe('status pemesanan', () => {
  test('pemesanan tanpa saga — belum pernah di-hold — tetap punya status', async () => {
    const world = sagaWorld()
    const held = await world.held()
    world.db.committed().sagas.delete(held.id)

    expect(await bookingStatus(world.deps, USER, held.id)).toMatchObject({ saga: undefined })
  })

  test('tuntas berarti pemesanan final DAN saga selesai', async () => {
    const world = sagaWorld()
    const paid = await world.paid()
    await world.supplierRejected(paid)
    await world.paymentRefunded(paid)

    const snapshot = await bookingStatus(world.deps, USER, paid.id)
    if (snapshot === undefined) throw new Error('persiapan gagal')

    expect(isSettled(snapshot)).toBe(true)
    expect(isSettled({ ...snapshot, saga: undefined })).toBe(true)
  })
})

describe('mengikuti perubahan', () => {
  test('setiap perubahan tepat sekali; pembacaan tanpa perubahan tidak terpancar', async () => {
    const world = sagaWorld()
    const paid = await world.paid()
    let sleeps = 0
    const steps = [
      async () => {
        await Promise.resolve()
      },
      async () => await world.supplierRejected(paid),
      async () => await world.paymentRefunded(paid),
    ]

    const seen = await collect(
      watchStatus(
        world.deps,
        { userId: USER, bookingId: paid.id },
        {
          intervalMs: 1,
          signal: new AbortController().signal,
          sleep: async () => {
            await steps[sleeps]?.()
            sleeps += 1
          },
        },
      ),
    )

    expect(seen.map((snapshot) => snapshot.booking.status)).toEqual(['PAID', 'FAILED', 'REFUNDED'])
    expect(sleeps).toBe(3)
  })

  test('penonton yang pergi menghentikan aliran', async () => {
    const world = sagaWorld()
    const held = await world.held()
    const controller = new AbortController()

    const seen = await collect(
      watchStatus(
        world.deps,
        { userId: USER, bookingId: held.id },
        {
          intervalMs: 1,
          signal: controller.signal,
          sleep: async () => {
            controller.abort()
            await Promise.resolve()
          },
        },
      ),
    )

    expect(seen).toHaveLength(1)
  })

  test('pemesanan orang lain tidak pernah terpancar', async () => {
    const world = sagaWorld()
    const held = await world.held()

    const seen = await collect(
      watchStatus(
        world.deps,
        { userId: OTHER_USER, bookingId: held.id },
        { intervalMs: 1, signal: new AbortController().signal, sleep: noPause },
      ),
    )

    expect(seen).toEqual([])
  })

  test('pemesanan tanpa saga yang sudah final: satu status, lalu selesai', async () => {
    const world = sagaWorld()
    world.suppliers.nextPrice({ kind: 'rejected', reason: 'sold_out' })
    await world.held().catch(() => undefined)
    const [cancelled] = [...world.db.committed().bookings.keys()]
    if (cancelled === undefined) throw new Error('persiapan gagal')

    const seen = await collect(
      watchStatus(
        world.deps,
        { userId: USER, bookingId: cancelled },
        { intervalMs: 1, signal: new AbortController().signal, sleep: noPause },
      ),
    )

    expect(seen.map((snapshot) => [snapshot.booking.status, snapshot.saga])).toEqual([
      ['CANCELLED', undefined],
    ])
  })
})
