import { createLogger } from '@tbe/shared-kernel'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { deliveryLoop } from './delivery-loop.js'

const logger = createLogger({ serviceName: 'notification-service-test', level: 'silent' })
const INTERVAL_MS = 1_000

afterEach(() => {
  vi.useRealTimers()
})

function counting(results: (number | Error)[] = []) {
  const calls = { count: 0 }
  const loop = deliveryLoop({
    intervalMs: INTERVAL_MS,
    batchSize: 10,
    logger,
    tick: async () => {
      calls.count += 1
      const next = results.shift() ?? 0
      if (next instanceof Error) throw next
      return await Promise.resolve(next)
    },
  })
  return { loop, calls }
}

describe('putaran penghantar', () => {
  test('berjalan segera saat menyala, lalu setiap selang', async () => {
    vi.useFakeTimers()
    const { loop, calls } = counting()

    await loop.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls.count).toBe(1)

    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    expect(calls.count).toBe(2)
    await loop.stop()
  })

  test('dibangunkan saat diam: putaran berikutnya dijalankan segera', async () => {
    vi.useFakeTimers()
    const { loop, calls } = counting()
    await loop.start()
    await vi.advanceTimersByTimeAsync(0)

    loop.wake()
    await vi.advanceTimersByTimeAsync(0)

    expect(calls.count).toBe(2)
    await loop.stop()
  })

  test('batch yang penuh langsung disusul putaran berikutnya', async () => {
    vi.useFakeTimers()
    const { loop, calls } = counting([10, 10, 3])
    await loop.start()

    await vi.advanceTimersByTimeAsync(INTERVAL_MS / 10)

    expect(calls.count).toBe(3)
    await loop.stop()
  })

  test('putaran yang gagal tidak menghentikan penghantar', async () => {
    vi.useFakeTimers()
    const { loop, calls } = counting([new Error('Postgres mati')])
    await loop.start()
    await vi.advanceTimersByTimeAsync(0)

    await vi.advanceTimersByTimeAsync(INTERVAL_MS)

    expect(calls.count).toBe(2)
    await loop.stop()
  })

  test('bangun di tengah putaran menjadwalkan satu putaran lagi, bukan putaran yang berpacu', async () => {
    let release: () => void = () => undefined
    let active = 0
    let maxActive = 0
    let calls = 0
    const loop = deliveryLoop({
      intervalMs: 60_000,
      batchSize: 10,
      logger,
      tick: async () => {
        calls += 1
        active += 1
        maxActive = Math.max(maxActive, active)
        if (calls === 1) await new Promise<void>((resolve) => (release = resolve))
        active -= 1
        return 0
      },
    })

    await loop.start()
    await vi.waitFor(() => {
      expect(calls).toBe(1)
    })
    loop.wake()
    loop.wake()
    release()
    await vi.waitFor(() => {
      expect(calls).toBe(2)
    })

    expect(maxActive).toBe(1)
    await loop.stop()
  })

  test('berhenti menunggu putaran yang sedang berjalan dan tidak menjadwalkan yang baru', async () => {
    vi.useFakeTimers()
    const { loop, calls } = counting()
    await loop.start()
    await vi.advanceTimersByTimeAsync(0)

    await loop.stop()
    loop.wake()
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 5)

    expect(calls.count).toBe(1)
  })
})
