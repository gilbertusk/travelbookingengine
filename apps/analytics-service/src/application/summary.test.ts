import { describe, expect, test } from 'vitest'
import { memoryStore } from '../testing/fakes.js'
import { analyticsSummary } from './summary.js'

describe('analyticsSummary', () => {
  test('hanya penghitung di dalam rentang yang dijumlahkan', async () => {
    const store = memoryStore()
    for (const [eventId, day] of [
      ['e-1', '2026-10-01'],
      ['e-2', '2026-10-02'],
      ['e-3', '2026-10-03'],
    ] as const) {
      await store.record(
        {
          eventId,
          eventType: 'search.performed',
          increments: [{ day, metric: 'funnel.search', dimension: '', by: 1 }],
        },
        new Date(),
      )
    }

    const report = await analyticsSummary({ store }, { from: '2026-10-02', to: '2026-10-03' }, 5)

    expect(report.range).toEqual({ from: '2026-10-02', to: '2026-10-03' })
    expect(report.summary.funnel[0]?.count).toBe(2)
  })
})
