import { money } from '@tbe/money'
import { describe, expect, test } from 'vitest'
import { effectiveHoldUntil } from './hold-window.js'
import { sellPriceBreakdown, type SellQuote } from './sell-price.js'

const QUOTE: SellQuote = {
  base: money(2_000_000, 'IDR'),
  markup: money(200_000, 'IDR'),
  tax: money(242_000, 'IDR'),
  total: money(2_442_000, 'IDR'),
  taxName: 'PPN 11%',
}

describe('harga jual dari pricing-service (FR-05)', () => {
  test('satu baris kamar (supplier + markup) dan satu baris pajak, totalnya harga jual', () => {
    const result = sellPriceBreakdown(QUOTE, 2)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.total).toEqual(money(2_442_000, 'IDR'))
    expect(result.value.lineItems).toEqual([
      { kind: 'room_night', description: 'Kamar, 2 malam', amount: money(2_200_000, 'IDR') },
      { kind: 'tax', description: 'PPN 11%', amount: money(242_000, 'IDR') },
    ])
  })

  test('total yang tidak sama dengan jumlah komponennya ditolak, walau selisihnya satu rupiah', () => {
    expect(sellPriceBreakdown({ ...QUOTE, total: money(2_442_001, 'IDR') }, 2)).toEqual({
      ok: false,
      error: { kind: 'inconsistent_total' },
    })
  })

  test('komponen bermata uang berbeda ditolak tanpa melempar', () => {
    expect(sellPriceBreakdown({ ...QUOTE, tax: money(10, 'USD') }, 2)).toEqual({
      ok: false,
      error: { kind: 'mixed_currency' },
    })
  })

  test('komponen negatif ditolak', () => {
    expect(sellPriceBreakdown({ ...QUOTE, markup: money(-1, 'IDR') }, 2)).toEqual({
      ok: false,
      error: { kind: 'negative_component' },
    })
  })

  test('harga jual nol ditolak dengan namanya sendiri', () => {
    const zero = money(0, 'IDR')

    expect(
      sellPriceBreakdown({ ...QUOTE, base: zero, markup: zero, tax: zero, total: zero }, 2),
    ).toEqual({
      ok: false,
      error: { kind: 'zero_total' },
    })
  })
})

describe('batas waktu hold efektif', () => {
  const local = new Date('2026-10-01T03:15:00.000Z')

  test('supplier lebih awal: supplier yang dipakai', () => {
    const supplier = new Date('2026-10-01T03:10:00.000Z')

    expect(effectiveHoldUntil(local, supplier)).toBe(supplier)
  })

  test('lokal lebih awal: lokal yang dipakai', () => {
    expect(effectiveHoldUntil(local, new Date('2026-10-01T03:20:00.000Z'))).toBe(local)
  })

  test('sama persis: lokal', () => {
    expect(effectiveHoldUntil(local, new Date(local.getTime()))).toBe(local)
  })
})
