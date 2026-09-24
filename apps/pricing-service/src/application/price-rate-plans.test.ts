import { describe, expect, test } from 'vitest'
import { money } from '@tbe/money'
import { resolveMarkup, selectRule } from '../domain/markup.js'
import { priceRatePlans, type RatePlanPriceRequest } from './price-rate-plans.js'
import { harness, percentageRule, USD_TO_IDR } from '../testing/fakes.js'

/**
 * Penetapan harga untuk sekumpulan rate plan.
 *
 * Dua hal yang dijaga di sini dan tidak dapat dijaga di domain: bahwa
 * pemuatan terjadi sekali per panggilan, dan bahwa satu item yang gagal tidak
 * menghapus hasil item lain.
 */

function request(overrides: Partial<RatePlanPriceRequest> = {}): RatePlanPriceRequest {
  return {
    ref: 'rp-1',
    supplier: 'SKY',
    city: 'Bali',
    supplierTotal: money(1_000_000, 'IDR'),
    ...overrides,
  }
}

describe('tanpa kueri per item', () => {
  test('memproses 500 rate plan dengan satu pemuatan kurs dan satu pemuatan aturan', async () => {
    // Inilah syaratnya, dan dibuktikan dengan MENGHITUNG pembacaan — bukan
    // dengan mengukur waktu. Pengukuran waktu akan lulus pada mesin cepat
    // meski kuerinya berulang lima ratus kali.
    const world = harness({ rules: [percentageRule()] })

    const items = Array.from({ length: 500 }, (_, index) =>
      request({ ref: `rp-${String(index)}`, supplierTotal: money(1_000_000 + index, 'IDR') }),
    )

    const run = await priceRatePlans(world.deps, items)

    expect(run.results).toHaveLength(500)
    expect(world.rates.reads.count).toBe(1)
    expect(world.rules.reads.count).toBe(1)
  })

  test('jumlah pembacaan tidak bergantung pada jumlah item', async () => {
    for (const size of [1, 10, 250]) {
      const world = harness({ rules: [percentageRule()] })
      const items = Array.from({ length: size }, (_, index) =>
        request({ ref: `rp-${String(index)}` }),
      )

      await priceRatePlans(world.deps, items)

      expect(world.rates.reads.count).toBe(1)
      expect(world.rules.reads.count).toBe(1)
    }
  })

  test('seluruh 500 hasil benar, bukan hanya jumlahnya', async () => {
    // Menghitung pembacaan saja dapat lulus dengan kode yang mengembalikan
    // hasil yang sama untuk semua item.
    const world = harness({ rules: [] })

    const items = Array.from({ length: 500 }, (_, index) =>
      request({ ref: `rp-${String(index)}`, supplierTotal: money(1_000 + index, 'IDR') }),
    )

    const run = await priceRatePlans(world.deps, items)
    const totals = new Set(
      run.results.map((result) => (result.ok ? result.breakdown.total.amountMinor : -1)),
    )

    expect(totals.size).toBe(500)
  })
})

describe('kegagalan per item', () => {
  test('satu item tanpa kurs tidak menghapus hasil item lain', async () => {
    // Satu kurs yang hilang untuk satu supplier tidak boleh menghapus hasil
    // dari empat supplier lain.
    const world = harness({ rates: [] })

    const run = await priceRatePlans(world.deps, [
      request({ ref: 'idr', supplierTotal: money(1_000_000, 'IDR') }),
      request({ ref: 'usd', supplierTotal: money(10_000, 'USD') }),
    ])

    const byRef = new Map(run.results.map((result) => [result.ref, result]))

    expect(byRef.get('idr')?.ok).toBe(true)
    expect(byRef.get('usd')?.ok).toBe(false)
  })

  test('pengenal milik pemanggil dikembalikan apa adanya', async () => {
    const world = harness()

    const run = await priceRatePlans(world.deps, [request({ ref: 'apa-pun-ini' })])

    expect(run.results[0]?.ref).toBe('apa-pun-ini')
  })

  test('daftar kosong menghasilkan hasil kosong, bukan galat', async () => {
    const world = harness()

    const run = await priceRatePlans(world.deps, [])

    expect(run.results).toEqual([])
  })
})

describe('kurs yang dipakai dilaporkan', () => {
  test('menyertakan kurs untuk penelusuran', async () => {
    const world = harness()

    const run = await priceRatePlans(world.deps, [request()])

    expect(run.ratesUsed).toEqual([USD_TO_IDR])
  })

  test('kurs terbaru yang menang bila ada beberapa untuk pasangan yang sama', async () => {
    // Tabel kurs menyimpan riwayat; riwayat itulah yang membuat harga
    // pemesanan lama tetap dapat dijelaskan.
    const world = harness({
      rates: [
        { ...USD_TO_IDR, rate: { amount: 15_000, scale: 0 }, asOf: '2026-08-01T00:00:00.000Z' },
        { ...USD_TO_IDR, rate: { amount: 16_500, scale: 0 }, asOf: '2026-09-10T00:00:00.000Z' },
      ],
    })

    const run = await priceRatePlans(world.deps, [request({ supplierTotal: money(10_000, 'USD') })])

    const result = run.results[0]
    expect(result?.ok).toBe(true)
    if (result?.ok !== true) return
    expect(result.breakdown.base.amountMinor).toBe(1_650_000)
  })

  test('kurs terbaru menang berapa pun urutan barisnya', async () => {
    // Urutan baris dari basis data bukan jaminan. Kalau yang menang adalah
    // "baris terakhir" alih-alih "tanggal terbaru", harga jual akan berubah
    // hanya karena kueri dijalankan ulang.
    const world = harness({
      rates: [
        { ...USD_TO_IDR, rate: { amount: 16_500, scale: 0 }, asOf: '2026-09-10T00:00:00.000Z' },
        { ...USD_TO_IDR, rate: { amount: 15_000, scale: 0 }, asOf: '2026-08-01T00:00:00.000Z' },
      ],
    })

    const run = await priceRatePlans(world.deps, [request({ supplierTotal: money(10_000, 'USD') })])

    const result = run.results[0]
    expect(result?.ok).toBe(true)
    if (result?.ok !== true) return
    expect(result.breakdown.base.amountMinor).toBe(1_650_000)
  })
})

describe('aturan markup diterapkan per item', () => {
  test('supplier berbeda dapat memakai aturan berbeda dalam satu panggilan', async () => {
    const world = harness({
      rules: [
        percentageRule({ id: 'global', percentageBasisPoints: 1_000 }),
        percentageRule({
          id: 'sky',
          scope: { supplier: 'SKY' },
          priority: 10,
          percentageBasisPoints: 2_000,
        }),
      ],
    })

    const run = await priceRatePlans(world.deps, [
      request({ ref: 'sky', supplier: 'SKY' }),
      request({ ref: 'nova', supplier: 'NOVA' }),
    ])

    const byRef = new Map(run.results.map((result) => [result.ref, result]))
    const sky = byRef.get('sky')
    const nova = byRef.get('nova')

    if (sky?.ok !== true || nova?.ok !== true) throw new Error('perhitungan gagal')

    expect(sky.breakdown.markup.amountMinor).toBe(200_000)
    expect(nova.breakdown.markup.amountMinor).toBe(100_000)
  })

  test('kota dicocokkan tanpa memedulikan huruf besar-kecil', () => {
    const rule = percentageRule({ id: 'bali', scope: { city: 'Bali' } })

    expect(selectRule([rule], { supplier: 'SKY', city: 'bali' })?.id).toBe('bali')
    expect(selectRule([rule], { supplier: 'SKY', city: 'BALI' })?.id).toBe('bali')
    expect(selectRule([rule], { supplier: 'SKY', city: 'Lombok' })).toBeUndefined()
  })

  test('aturan yang rusak diperlakukan sebagai tanpa markup, bukan nol persen', () => {
    // Perbedaannya terlihat di rincian harga: tanpa markup tidak menyebut
    // aturan mana pun, sedangkan nol persen akan menyebutnya.
    const broken = percentageRule({ id: 'rusak', percentageBasisPoints: undefined })

    expect(resolveMarkup(broken).kind).toBe('none')
  })
})
