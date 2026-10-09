import { describe, expect, test } from 'vitest'
import {
  announcement,
  clockOffset,
  countdown,
  crossedThreshold,
  formatClock,
  WARNING_BELOW_MS,
} from './countdown'

const HELD_UNTIL = '2026-10-06T10:15:00.000Z'
const at = (iso: string) => Date.parse(iso)

describe('selisih jam server', () => {
  test('jam lokal yang terlambat lima menit dikoreksi', () => {
    // Server berkata 10:00:00; jam lokal menunjukkan 09:55:00 saat permintaan
    // dikirim dan saat jawaban tiba (perjalanan seketika).
    const local = at('2026-10-06T09:55:00.000Z')

    expect(clockOffset('2026-10-06T10:00:00.000Z', local, local)).toBe(5 * 60_000)
  })

  test('dibandingkan dengan titik tengah perjalanan, bukan saat jawaban tiba', () => {
    const sent = at('2026-10-06T10:00:00.000Z')
    const received = sent + 2_000

    expect(clockOffset('2026-10-06T10:00:01.000Z', sent, received)).toBe(0)
  })

  test('jam server yang tidak terbaca tidak menggeser apa pun', () => {
    expect(clockOffset('bukan-tanggal', 0, 0)).toBe(0)
  })
})

describe('hitung mundur', () => {
  test('memakai jam server: jam lokal yang terlambat tidak memberi waktu tambahan', () => {
    // Lokal 09:55, server 10:00 → sisa sesungguhnya 15 menit, bukan 20.
    const state = countdown(HELD_UNTIL, at('2026-10-06T09:55:00.000Z'), 5 * 60_000)

    expect(state.clock).toBe('15:00')
    expect(state.tone).toBe('neutral')
  })

  test('netral tepat di 5 menit, peringatan di bawahnya', () => {
    const fiveMinutesLeft = at(HELD_UNTIL) - WARNING_BELOW_MS

    expect(countdown(HELD_UNTIL, fiveMinutesLeft, 0).tone).toBe('neutral')
    expect(countdown(HELD_UNTIL, fiveMinutesLeft + 1, 0).tone).toBe('warning')
  })

  test('habis tidak pernah negatif', () => {
    const state = countdown(HELD_UNTIL, at(HELD_UNTIL) + 60_000, 0)

    expect(state).toEqual({ remainingMs: 0, tone: 'expired', clock: '0:00' })
  })

  test('detik dibulatkan ke atas: 0:00 hanya ketika benar-benar habis', () => {
    expect(formatClock(1)).toBe('0:01')
    expect(formatClock(59_001)).toBe('1:00')
    expect(formatClock(0)).toBe('0:00')
  })
})

describe('pengumuman pembaca layar', () => {
  test('hanya pada ambang, bukan setiap detik', () => {
    expect(crossedThreshold(6 * 60_000, 5 * 60_000 + 1)).toBeUndefined()
    expect(crossedThreshold(5 * 60_000 + 1, 5 * 60_000)).toBe(5 * 60_000)
  })

  test('tab yang tertidur melompati detik ambang tetap diumumkan', () => {
    expect(crossedThreshold(5 * 60_000 + 30_000, 4 * 60_000)).toBe(5 * 60_000)
  })

  test('kalimatnya menit, atau detik di bawah satu menit', () => {
    expect(announcement(5 * 60_000)).toBe('Sisa waktu 5 menit.')
    expect(announcement(30_000)).toBe('Sisa waktu 30 detik.')
  })
})
