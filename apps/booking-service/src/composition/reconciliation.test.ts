import type { CommandSender } from '@tbe/messaging'
import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import { operatorTrigger, reconciliationRequests } from './reconciliation.js'

/**
 * Perangkaian rekonsiliasi (Step 28): bentuk perintah yang benar-benar
 * dikirim. eventId-lah yang menyatukan putaran antar-instance, jadi yang
 * diperiksa di sini adalah bahwa pengenal putaran SAMPAI ke amplop pesan.
 */

interface Sent {
  readonly type: string
  readonly payload: unknown
  readonly eventId: string | undefined
}

function recordingSender(): CommandSender & { readonly sent: Sent[] } {
  const sent: Sent[] = []
  return {
    sent,
    async send(type, payload, options) {
      sent.push({ type, payload, eventId: options?.eventId })
      await Promise.resolve()
    },
  }
}

describe('perintah reconciliation.run', () => {
  test('pengenal putaran menjadi eventId; supplier hanya disertakan bila disebut', async () => {
    const sender = recordingSender()
    const requests = reconciliationRequests(sender)

    await requests.request({ id: 'slot-1', day: '2026-10-01' })
    await requests.request({ id: 'slot-2', day: '2026-10-01', supplier: 'NOVA' })

    expect(sender.sent).toEqual([
      { type: 'reconciliation.run', payload: { date: '2026-10-01' }, eventId: 'slot-1' },
      {
        type: 'reconciliation.run',
        payload: { date: '2026-10-01', supplier: 'NOVA' },
        eventId: 'slot-2',
      },
    ])
  })

  test('pemicu operator: pengenal acak setiap kali, hari ini menurut UTC', async () => {
    const sender = recordingSender()
    // 23:30 di Jakarta sudah tanggal berikutnya; hari UTC-nya tetap 1 Oktober.
    const trigger = operatorTrigger(
      reconciliationRequests(sender),
      () => new Date('2026-10-01T17:30:00Z'),
    )

    const first = await trigger(undefined)
    const second = await trigger('SKY')

    expect(z.uuid().safeParse(first).success).toBe(true)
    expect(second).not.toBe(first)
    expect(sender.sent.map((sent) => [sent.eventId, sent.payload])).toEqual([
      [first, { date: '2026-10-01' }],
      [second, { date: '2026-10-01', supplier: 'SKY' }],
    ])
  })
})
