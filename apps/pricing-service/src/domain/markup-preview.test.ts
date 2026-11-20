import { describe, expect, test } from 'vitest'
import { percentageRule } from '../testing/fakes.js'
import { PREVIEW_RULE_ID, applyChange } from './markup-preview.js'

const global = percentageRule({ id: 'r-global', percentageBasisPoints: 1_000 })
const bali = percentageRule({ id: 'r-bali', scope: { city: 'Bali' }, percentageBasisPoints: 2_000 })

describe('applyChange', () => {
  test('membuat: aturan baru ditambahkan dengan pengenal sementara, daftar asli utuh', () => {
    const rules = [global]

    const applied = applyChange(rules, { kind: 'create', rule: { ...bali, name: 'baru' } })

    expect(applied.ok && applied.rules.map((rule) => rule.id)).toEqual([
      'r-global',
      PREVIEW_RULE_ID,
    ])
    expect(rules).toHaveLength(1)
  })

  test('membuat aturan yang seri dengan aturan aktif lain menandai pemutus tidak pasti', () => {
    const applied = applyChange([bali], {
      kind: 'create',
      rule: { ...bali, name: 'kembar', scope: { city: 'bali' } },
    })

    expect(applied.ok && applied.isTieBreakUncertain).toBe(true)
  })

  test('seri hanya bila prioritas, kekhususan, DAN cakupannya sama, dan kandidatnya aktif', () => {
    const cases = [
      { ...bali, priority: 1 },
      { ...bali, scope: { city: 'Jakarta' } },
      { ...bali, scope: { supplier: 'SKY' as const, city: 'Bali' } },
      { ...bali, isActive: false },
    ]

    for (const rule of cases) {
      const applied = applyChange([bali], { kind: 'create', rule })
      expect(applied.ok && applied.isTieBreakUncertain).toBe(false)
    }
  })

  test('aturan nonaktif yang ada tidak dihitung sebagai seri', () => {
    const applied = applyChange([{ ...bali, isActive: false }], { kind: 'create', rule: bali })

    expect(applied.ok && applied.isTieBreakUncertain).toBe(false)
  })

  test('mengubah: hanya bidang yang dikirim yang berganti', () => {
    const applied = applyChange([global, bali], {
      kind: 'update',
      id: 'r-bali',
      patch: { percentageBasisPoints: 500 },
    })

    expect(applied.ok && applied.rules[1]).toEqual({ ...bali, percentageBasisPoints: 500 })
    expect(applied.ok && applied.rules[0]).toBe(global)
  })

  test('mengubah prioritas dan status aktif', () => {
    const applied = applyChange([global], {
      kind: 'update',
      id: 'r-global',
      patch: { priority: 9, isActive: false },
    })

    expect(applied.ok && applied.rules[0]).toMatchObject({ priority: 9, isActive: false })
  })

  test('menonaktifkan', () => {
    const applied = applyChange([global], { kind: 'deactivate', id: 'r-global' })

    expect(applied.ok && applied.rules[0]?.isActive).toBe(false)
  })

  test('pengenal yang tidak ada ditolak, bukan diam-diam tanpa perubahan', () => {
    expect(applyChange([global], { kind: 'deactivate', id: 'hilang' })).toEqual({
      ok: false,
      reason: 'rule_not_found',
    })
    expect(applyChange([global], { kind: 'update', id: 'hilang', patch: {} }).ok).toBe(false)
  })
})
