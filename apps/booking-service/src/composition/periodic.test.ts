import { createLogger } from '@tbe/shared-kernel'
import { describe, expect, test } from 'vitest'
import { periodicResource } from './periodic.js'

/**
 * Pekerjaan berkala: putaran berikutnya dijadwalkan setelah putaran
 * sebelumnya selesai, dan SEGERA bila putaran itu melaporkan pekerjaan
 * tersisa.
 */

const logger = createLogger({ serviceName: 'booking-service-test', level: 'silent' })

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('kondisi tidak pernah terpenuhi')
}

describe('pekerjaan berkala', () => {
  test('pekerjaan tersisa dikerjakan segera, tanpa menunggu selang yang panjang', async () => {
    // Selang satu jam: bila putaran kedua dan ketiga menunggu selang, uji ini
    // tidak pernah selesai.
    let calls = 0
    const job = periodicResource({
      name: 'uji',
      intervalMs: 3_600_000,
      logger,
      failure: 'gagal',
      runOnStart: true,
      tick: async () => {
        calls += 1
        return await Promise.resolve(calls < 3)
      },
    })

    await job.start?.()
    await until(() => calls >= 3)
    await job.stop()

    expect(calls).toBe(3)
  })

  test('tanpa putaran saat startup, putaran pertama menunggu selangnya', async () => {
    let calls = 0
    const job = periodicResource({
      name: 'uji',
      intervalMs: 3_600_000,
      logger,
      failure: 'gagal',
      tick: async () => {
        calls += 1
        return await Promise.resolve(false)
      },
    })

    await job.start?.()
    await new Promise((resolve) => setTimeout(resolve, 20))
    await job.stop()

    expect(calls).toBe(0)
  })
})
