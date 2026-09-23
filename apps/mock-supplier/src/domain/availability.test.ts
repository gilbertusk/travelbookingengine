import { describe, expect, test } from 'vitest'
import {
  MAX_UNITS_PER_NIGHT,
  availableForStay,
  baseAvailability,
  remainingUnits,
} from './availability.js'
import { buildCatalog } from './catalog.js'
import { fractionOf, intBetween, pickSome } from './deterministic.js'

describe('deterministic', () => {
  test('kunci yang sama selalu menghasilkan nilai yang sama', () => {
    expect(fractionOf('a', 'b')).toBe(fractionOf('a', 'b'))
    expect(intBetween(1, 100, 'x')).toBe(intBetween(1, 100, 'x'))
  })

  test('kunci berbeda menghasilkan nilai berbeda', () => {
    expect(fractionOf('a')).not.toBe(fractionOf('b'))
  })

  test('intBetween tetap di dalam rentang inklusif', () => {
    const nilai = Array.from({ length: 200 }, (_u, index) => intBetween(3, 7, String(index)))

    expect(Math.min(...nilai)).toBeGreaterThanOrEqual(3)
    expect(Math.max(...nilai)).toBeLessThanOrEqual(7)
  })

  test('pickSome mengembalikan jumlah yang diminta tanpa duplikat', () => {
    const hasil = pickSome(['a', 'b', 'c', 'd', 'e'], 3, 'kunci')

    expect(hasil).toHaveLength(3)
    expect(new Set(hasil).size).toBe(3)
  })
})

describe('availability', () => {
  test('ketersediaan sama untuk rate plan dan tanggal yang sama', () => {
    // Inilah yang membuat uji oversell dapat diulang antar proses.
    expect(baseAvailability('rpl_x', '2026-11-10')).toBe(baseAvailability('rpl_x', '2026-11-10'))
  })

  test('ketersediaan berada dalam batas yang masuk akal', () => {
    const nilai = Array.from({ length: 400 }, (_u, index) =>
      baseAvailability(`rpl_${String(index)}`, '2026-11-10'),
    )

    expect(Math.min(...nilai)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...nilai)).toBeLessThanOrEqual(MAX_UNITS_PER_NIGHT)
  })

  test('sekitar 7 persen malam habis, agar pencarian tidak selalu penuh', () => {
    // Disampel lintas rate plan DAN lintas tanggal. Menyampel satu rate plan
    // saja hanya menghasilkan 28 nilai berbeda, dan hasilnya lebih bergantung
    // pada rate plan mana yang kebetulan dipilih daripada pada sebarannya.
    const contoh = Array.from({ length: 2_000 }, (_u, index) =>
      baseAvailability(
        `rpl_${String(index)}`,
        `2026-11-${String((index % 28) + 1).padStart(2, '0')}`,
      ),
    )
    const habis = contoh.filter((units) => units === 0).length

    expect(habis / contoh.length).toBeGreaterThan(0.04)
    expect(habis / contoh.length).toBeLessThan(0.11)
  })

  test('unit tersisa tidak pernah negatif meski konsumsi berlebih', () => {
    expect(remainingUnits('rpl_x', '2026-11-10', 999)).toBe(0)
  })

  test('ketersediaan menginap adalah yang terkecil di antara malamnya', () => {
    // Satu malam yang habis membuat seluruh rentang tidak dapat dipesan.
    const units = availableForStay(['a', 'b', 'c'], (date) => (date === 'b' ? 1 : 5))

    expect(units).toBe(1)
  })

  test('rentang tanpa malam tidak tersedia', () => {
    expect(availableForStay([], () => 9)).toBe(0)
  })
})

describe('katalog', () => {
  const catalog = buildCatalog()

  test('membangun properti untuk delapan kota', () => {
    expect(new Set(catalog.properties.map((p) => p.city)).size).toBe(8)
    expect(catalog.properties).toHaveLength(320)
  })

  test('setiap properti punya kamar dan setiap kamar punya tarif', () => {
    const contoh = catalog.properties[0]
    const kamar = catalog.roomTypes.filter((r) => r.propertyId === contoh?.id)
    const tarif = catalog.ratePlans.filter((r) => r.roomTypeId === kamar[0]?.id)

    expect(kamar.length).toBeGreaterThanOrEqual(2)
    expect(tarif.length).toBeGreaterThanOrEqual(2)
  })

  test('katalog identik pada pembangunan ulang', () => {
    const lagi = buildCatalog()

    expect(lagi.properties[0]).toEqual(catalog.properties[0])
    expect(lagi.ratePlans.length).toBe(catalog.ratePlans.length)
  })

  test('setiap properti membawa zona waktunya sendiri', () => {
    // Dibutuhkan Step 12b dan Step 25 untuk menghitung tenggat pembatalan.
    expect(catalog.properties.every((p) => p.timezone.includes('/'))).toBe(true)
  })

  test('tarif non-refundable lebih murah daripada yang refundable', () => {
    const contoh = catalog.roomTypes[0]
    const tarif = catalog.ratePlans.filter((r) => r.roomTypeId === contoh?.id)
    const refundable = tarif.find((r) => r.refundable)
    const nonRefundable = tarif.find((r) => !r.refundable)

    expect(refundable).toBeDefined()
    expect(nonRefundable).toBeDefined()
    expect(nonRefundable?.basePriceMinorIdr).toBeLessThan(refundable?.basePriceMinorIdr ?? 0)
  })
})
