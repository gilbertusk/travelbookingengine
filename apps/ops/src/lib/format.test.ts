import { describe, expect, test } from 'vitest'
import { count, dateTime, milliseconds, money, percent } from './format'

describe('format', () => {
  test('basis poin → persen; tanpa pembagi "—", bukan 0%', () => {
    expect(percent(1_250)).toBe('12,5%')
    expect(percent(0)).toBe('0%')
    expect(percent(null)).toBe('—')
  })

  test('milidetik dan jumlah', () => {
    expect(milliseconds(1_234)).toBe('1.234 ms')
    expect(milliseconds(null)).toBe('—')
    expect(count(12_000)).toBe('12.000')
  })

  test('uang: IDR tanpa desimal, USD dua desimal', () => {
    expect(money({ amountMinor: 2_442_000, currency: 'IDR' }).replace(/\s/g, ' ')).toBe(
      'Rp 2.442.000',
    )
    expect(money({ amountMinor: 12_345, currency: 'USD' })).toContain('123,45')
  })

  test('waktu dalam WIB, apa pun zona peramban', () => {
    expect(dateTime('2026-10-25T17:30:00.000Z')).toMatch(/26 Okt 2026.*00\.30\.00 WIB/)
  })
})
