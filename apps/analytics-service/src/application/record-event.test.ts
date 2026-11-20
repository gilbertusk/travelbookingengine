import { describe, expect, test } from 'vitest'
import { deps, memoryStore } from '../testing/fakes.js'
import { recordEvent, type IncomingFact } from './record-event.js'

const BOOKING = '3f0c8a52-6d1e-4c3b-9a7f-0e1d2c3b4a59'
const at = (eventType: string) => ({ occurredAt: '2026-10-25T03:00:00.000Z', eventType })
const held: IncomingFact = {
  eventId: 'e-1',
  occurrence: at('booking.held'),
  fact: { kind: 'booking_held', bookingId: BOOKING },
}

describe('recordEvent', () => {
  test('pesan yang sama dua kali dihitung sekali', async () => {
    const store = memoryStore()

    expect(await recordEvent(deps(store), held)).toBe('recorded')
    expect(await recordEvent(deps(store), held)).toBe('duplicate')

    const rows = await store.counters({ from: '2026-10-25', to: '2026-10-25' })
    expect(rows.find((row) => row.metric === 'funnel.held')?.value).toBe(1)
  })

  test('perubahan harga dihitung untuk supplier dari booking.created sebelumnya', async () => {
    const store = memoryStore()
    await recordEvent(deps(store), {
      eventId: 'e-1',
      occurrence: at('booking.created'),
      fact: { kind: 'booking_created', bookingId: BOOKING, supplier: 'ORBIT' },
    })
    await recordEvent(deps(store), {
      eventId: 'e-2',
      occurrence: at('booking.price_changed'),
      fact: { kind: 'price_changed', bookingId: BOOKING },
    })

    const rows = await store.counters({ from: '2026-10-25', to: '2026-10-25' })
    expect(
      rows.find((row) => row.metric === 'supplier.price_changed' && row.dimension === 'ORBIT')
        ?.value,
    ).toBe(1)
  })

  test('basis data gagal: galatnya dilempar, supaya offset tidak di-commit dan pesan dibaca lagi', async () => {
    const store = memoryStore()
    store.failNextRecord()

    await expect(recordEvent(deps(store), held)).rejects.toThrow()
    expect(await recordEvent(deps(store), held)).toBe('recorded')
  })
})
