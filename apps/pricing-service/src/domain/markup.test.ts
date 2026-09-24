import { describe, expect, test } from 'vitest'
import { money } from '@tbe/money'
import { resolveMarkup, selectRule, specificity, type MarkupRule } from './markup.js'

/**
 * Prioritas aturan markup.
 *
 * Lebih dari satu aturan dapat cocok untuk permintaan yang sama, dan yang
 * menentukan mana yang dipakai harus dapat diuji — bukan bergantung pada
 * urutan baris di basis data, yang berubah setiap kali ada yang diedit.
 */

function rule(overrides: Partial<MarkupRule> = {}): MarkupRule {
  return {
    id: 'r',
    name: 'aturan',
    priority: 0,
    scope: {},
    kind: 'percentage',
    percentageBasisPoints: 1_000,
    isActive: true,
    ...overrides,
  }
}

const BALI_SKY = { supplier: 'SKY', city: 'Bali' }

describe('kekhususan cakupan', () => {
  test('supplier dan kota lebih khusus daripada salah satunya', () => {
    expect(specificity({ supplier: 'SKY', city: 'Bali' })).toBeGreaterThan(
      specificity({ supplier: 'SKY' }),
    )
    expect(specificity({ supplier: 'SKY' })).toBeGreaterThan(specificity({ city: 'Bali' }))
    expect(specificity({ city: 'Bali' })).toBeGreaterThan(specificity({}))
  })
})

describe('pemilihan aturan', () => {
  test('prioritas tertinggi menang', () => {
    const rules = [
      rule({ id: 'rendah', priority: 1 }),
      rule({ id: 'tinggi', priority: 10 }),
      rule({ id: 'sedang', priority: 5 }),
    ]

    expect(selectRule(rules, BALI_SKY)?.id).toBe('tinggi')
  })

  test('prioritas sama diputus oleh kekhususan', () => {
    const rules = [
      rule({ id: 'global', scope: {} }),
      rule({ id: 'kota', scope: { city: 'Bali' } }),
      rule({ id: 'supplier-kota', scope: { supplier: 'SKY', city: 'Bali' } }),
    ]

    expect(selectRule(rules, BALI_SKY)?.id).toBe('supplier-kota')
  })

  test('prioritas mengalahkan kekhususan', () => {
    // Operator yang memberi satu aturan prioritas tinggi bermaksud aturan itu
    // menang, meski cakupannya lebih umum.
    const rules = [
      rule({ id: 'global-prioritas', scope: {}, priority: 100 }),
      rule({ id: 'supplier-kota', scope: { supplier: 'SKY', city: 'Bali' }, priority: 0 }),
    ]

    expect(selectRule(rules, BALI_SKY)?.id).toBe('global-prioritas')
  })

  test('prioritas dan kekhususan sama diputus pengenal, supaya deterministik', () => {
    // Pemutus terakhir. Bukan karena pengenal punya arti, melainkan supaya
    // hasilnya tidak berubah antar pemanggilan.
    const rules = [rule({ id: 'b' }), rule({ id: 'a' })]

    expect(selectRule(rules, BALI_SKY)?.id).toBe('a')
    expect(selectRule([...rules].reverse(), BALI_SKY)?.id).toBe('a')
  })

  test('aturan nonaktif tidak pernah dipilih', () => {
    const rules = [rule({ id: 'mati', priority: 100, isActive: false }), rule({ id: 'hidup' })]

    expect(selectRule(rules, BALI_SKY)?.id).toBe('hidup')
  })

  test('aturan untuk supplier lain tidak cocok', () => {
    const rules = [rule({ id: 'nova', scope: { supplier: 'NOVA' } })]

    expect(selectRule(rules, BALI_SKY)).toBeUndefined()
  })

  test('tanpa aturan yang cocok, tidak ada yang dipilih', () => {
    expect(selectRule([], BALI_SKY)).toBeUndefined()
  })

  test('daftar aturan tidak diubah saat dipilih', () => {
    // Mengurutkan di tempat akan mengubah daftar yang dipakai bersama seluruh
    // rate plan dalam satu panggilan.
    const rules = [rule({ id: 'b', priority: 1 }), rule({ id: 'a', priority: 10 })]
    const before = rules.map((item) => item.id)

    selectRule(rules, BALI_SKY)

    expect(rules.map((item) => item.id)).toEqual(before)
  })
})

describe('penerjemahan aturan menjadi markup', () => {
  test('aturan persentase menjadi basis poin', () => {
    const resolved = resolveMarkup(rule({ id: 'r-1', percentageBasisPoints: 1_250 }))

    expect(resolved).toEqual({ kind: 'percentage', basisPoints: 1_250, ruleId: 'r-1' })
  })

  test('aturan nominal menjadi jumlah uang', () => {
    const resolved = resolveMarkup(
      rule({ id: 'r-2', kind: 'fixed', fixedAmount: money(50_000, 'IDR') }),
    )

    expect(resolved).toEqual({ kind: 'fixed', amount: money(50_000, 'IDR'), ruleId: 'r-2' })
  })

  test('tanpa aturan berarti tanpa markup', () => {
    expect(resolveMarkup(undefined)).toEqual({ kind: 'none' })
  })

  test('aturan persentase tanpa angkanya dianggap tidak ada', () => {
    expect(resolveMarkup(rule({ percentageBasisPoints: undefined })).kind).toBe('none')
  })

  test('aturan nominal tanpa nominalnya dianggap tidak ada', () => {
    expect(resolveMarkup(rule({ kind: 'fixed', fixedAmount: undefined })).kind).toBe('none')
  })
})
