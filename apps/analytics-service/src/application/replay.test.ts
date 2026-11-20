import { describe, expect, test } from 'vitest'
import { memoryStore, recordingOffsets } from '../testing/fakes.js'
import type { AnalyticsStore } from './ports.js'
import { replay } from './replay.js'

const TARGET = { groupId: 'analytics-service', topics: ['tbe.booking.v1', 'tbe.search.v1'] }

async function seeded(): Promise<ReturnType<typeof memoryStore>> {
  const store = memoryStore()
  await store.record(
    {
      eventId: 'e-1',
      eventType: 'booking.held',
      increments: [{ day: '2026-10-25', metric: 'funnel.held', dimension: '', by: 1 }],
    },
    new Date(),
  )
  return store
}

describe('replay', () => {
  test('group masih aktif: ditolak, offset dan agregat tidak disentuh', async () => {
    const store = await seeded()
    const offsets = recordingOffsets({ kind: 'active', members: 2, state: 'Stable' })

    const outcome = await replay({ store, offsets }, TARGET)

    expect(outcome).toEqual({ kind: 'group_active', members: 2, state: 'Stable' })
    expect(offsets.rewound).toEqual([])
    expect(await store.processedCount()).toBe(1)
  })

  test('group kosong: setiap topik diputar ke awal, lalu ketiga tabel dikosongkan', async () => {
    const store = await seeded()
    const offsets = recordingOffsets()

    const outcome = await replay({ store, offsets }, TARGET)

    expect(outcome).toEqual({ kind: 'rewound', topics: TARGET.topics })
    expect(offsets.rewound).toEqual([
      { groupId: 'analytics-service', topic: 'tbe.booking.v1' },
      { groupId: 'analytics-service', topic: 'tbe.search.v1' },
    ])
    expect(store.rows().size).toBe(0)
    expect(store.processed().size).toBe(0)
  })

  test('pengosongan gagal SETELAH offset diputar: agregat lama tetap utuh — tidak ada yang hilang', async () => {
    // Bila urutannya dibalik, kegagalan pemutaran offset meninggalkan agregat
    // kosong dengan offset di ujung topik.
    const store = await seeded()
    const failing: AnalyticsStore = {
      ...store,
      reset: async () => {
        await Promise.resolve()
        throw new Error('basis data mati')
      },
    }
    const offsets = recordingOffsets()

    await expect(replay({ store: failing, offsets }, TARGET)).rejects.toThrow()

    expect(offsets.rewound).toHaveLength(2)
    expect(await store.processedCount()).toBe(1)
  })

  test('pemutaran offset gagal: agregat tidak dikosongkan', async () => {
    const store = await seeded()
    const offsets = {
      ...recordingOffsets(),
      rewindToEarliest: async () => {
        await Promise.resolve()
        throw new Error('broker mati')
      },
    }

    await expect(replay({ store, offsets }, TARGET)).rejects.toThrow()

    expect(await store.processedCount()).toBe(1)
  })
})
