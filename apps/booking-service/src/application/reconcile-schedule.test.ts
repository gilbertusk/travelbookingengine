import { COMMAND_PAYLOADS } from '@tbe/event-contracts'
import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import { createScheduler, runIdFor, slotAt } from './reconcile-schedule.js'

const SIX_HOURS = 6 * 60 * 60 * 1_000

describe('slot rekonsiliasi', () => {
  test('dua instance pada slot yang sama menurunkan pengenal yang sama', () => {
    const first = slotAt(new Date('2026-10-01T06:00:01Z'), SIX_HOURS)
    const second = slotAt(new Date('2026-10-01T11:59:59Z'), SIX_HOURS)

    expect(first.runId).toBe(second.runId)
    expect(first.startedAt.toISOString()).toBe('2026-10-01T06:00:00.000Z')
    expect(first.day).toBe('2026-10-01')
  })

  test('slot berikutnya mendapat pengenal lain', () => {
    const before = slotAt(new Date('2026-10-01T11:59:59Z'), SIX_HOURS)
    const after = slotAt(new Date('2026-10-01T12:00:00Z'), SIX_HOURS)

    expect(after.runId).not.toBe(before.runId)
  })

  test('pengenalnya UUID yang diterima kontrak pesan, dan perintahnya sah', () => {
    const slot = slotAt(new Date('2026-10-01T06:00:00Z'), SIX_HOURS)

    expect(z.uuid().safeParse(slot.runId).success).toBe(true)
    expect(slot.runId[14]).toBe('8')
    expect(COMMAND_PAYLOADS['reconciliation.run'].safeParse({ date: slot.day }).success).toBe(true)
  })

  test('pengenal hanya bergantung pada awal slot', () => {
    expect(runIdFor(new Date('2026-10-01T06:00:00Z'))).toBe(
      runIdFor(new Date('2026-10-01T06:00:00.000Z')),
    )
  })
})

describe('detak penjadwal', () => {
  function scheduler(failures = 0) {
    const clock = { value: new Date('2026-10-01T06:00:00Z') }
    const sent: { id: string; day: string }[] = []
    let remainingFailures = failures
    const instance = createScheduler({
      intervalMs: SIX_HOURS,
      now: () => clock.value,
      requests: {
        request: async (run) => {
          await Promise.resolve()
          if (remainingFailures > 0) {
            remainingFailures -= 1
            throw new Error('RabbitMQ mati')
          }
          sent.push({ id: run.id, day: run.day })
        },
      },
    })
    return { clock, sent, tick: async () => await instance.tick() }
  }

  test('satu perintah per slot, berapa kali pun berdetak', async () => {
    const { clock, sent, tick } = scheduler()

    await tick()
    clock.value = new Date('2026-10-01T07:00:00Z')
    await tick()
    clock.value = new Date('2026-10-01T12:00:00Z')
    await tick()

    expect(sent.map((run) => run.id)).toEqual([
      runIdFor(new Date('2026-10-01T06:00:00Z')),
      runIdFor(new Date('2026-10-01T12:00:00Z')),
    ])
  })

  test('pengiriman yang gagal dicoba lagi pada detak berikutnya, bukan dilewatkan', async () => {
    const { sent, tick } = scheduler(1)

    await expect(tick()).rejects.toThrow('RabbitMQ mati')
    await tick()

    expect(sent).toHaveLength(1)
  })
})
