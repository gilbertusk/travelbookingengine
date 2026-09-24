import { describe, expect, test } from 'vitest'
import { add, money, type Money } from '@tbe/money'
import { calculatePrice, percentToBasisPoints, type PriceInput } from './pricing.js'
import type { ResolvedMarkup } from './markup.js'

/**
 * Urutan perhitungan harga.
 *
 * Setiap angka yang diharapkan di bawah dihitung tangan dan ditulis
 * perhitungannya. Pengujian harga yang hanya membandingkan dengan keluaran
 * kode itu sendiri tidak membuktikan apa pun — ia hanya membekukan kesalahan
 * yang ada.
 */

const PPN: PriceInput['tax'] = { name: 'PPN', basisPoints: percentToBasisPoints(11) }
const NO_TAX: PriceInput['tax'] = { name: 'tanpa pajak', basisPoints: 0 }
const NO_MARKUP: ResolvedMarkup = { kind: 'none' }

const USD_TO_IDR = {
  from: 'USD' as const,
  to: 'IDR' as const,
  rate: { amount: 16_000, scale: 0 },
  asOf: '2026-09-01T00:00:00.000Z',
}

function priceOf(overrides: Partial<PriceInput> = {}) {
  const result = calculatePrice({
    supplierTotal: money(1_000_000, 'IDR'),
    sellingCurrency: 'IDR',
    markup: NO_MARKUP,
    tax: NO_TAX,
    rounding: 'half_even',
    ...overrides,
  })

  if (!result.ok) throw new Error(`perhitungan gagal: ${result.error.kind}`)

  return result.breakdown
}

describe('urutan perhitungan terhadap contoh yang dihitung manual', () => {
  test('markup persentase lalu pajak, dalam mata uang yang sama', () => {
    // Rp 1.000.000 × 1,15 = Rp 1.150.000 (markup Rp 150.000)
    // Rp 1.150.000 × 0,11 = Rp 126.500 pajak
    // Total = Rp 1.276.500
    const breakdown = priceOf({
      markup: { kind: 'percentage', basisPoints: percentToBasisPoints(15), ruleId: 'r-1' },
      tax: PPN,
    })

    expect(breakdown.base.amountMinor).toBe(1_000_000)
    expect(breakdown.markup.amountMinor).toBe(150_000)
    expect(breakdown.tax.amountMinor).toBe(126_500)
    expect(breakdown.total.amountMinor).toBe(1_276_500)
  })

  test('pajak dikenakan SETELAH markup, bukan sebelumnya', () => {
    // Kalau urutannya terbalik: pajak atas Rp 1.000.000 = Rp 110.000, dan
    // totalnya Rp 1.260.000 — selisih Rp 16.500 per pemesanan. Itu bukan
    // pembulatan; itu markup dikali tarif pajak.
    const breakdown = priceOf({
      markup: { kind: 'percentage', basisPoints: percentToBasisPoints(15), ruleId: 'r-1' },
      tax: PPN,
    })

    expect(breakdown.tax.amountMinor).toBe(126_500)
    expect(breakdown.tax.amountMinor).not.toBe(110_000)
    expect(breakdown.total.amountMinor).not.toBe(1_260_000)
  })

  test('konversi terjadi SEBELUM markup', () => {
    // $100,00 × 16.000 = Rp 1.600.000
    // × 1,15 = Rp 1.840.000 (markup Rp 240.000)
    // × 0,11 = Rp 202.400 pajak
    // Total = Rp 2.042.400
    const breakdown = priceOf({
      supplierTotal: money(10_000, 'USD'),
      exchangeRate: USD_TO_IDR,
      markup: { kind: 'percentage', basisPoints: percentToBasisPoints(15), ruleId: 'r-1' },
      tax: PPN,
    })

    expect(breakdown.base.amountMinor).toBe(1_600_000)
    expect(breakdown.markup.amountMinor).toBe(240_000)
    expect(breakdown.tax.amountMinor).toBe(202_400)
    expect(breakdown.total.amountMinor).toBe(2_042_400)
  })

  test('markup nominal tetap ditambahkan setelah konversi', () => {
    // $100,00 × 16.000 = Rp 1.600.000
    // + Rp 50.000 = Rp 1.650.000
    // × 0,11 = Rp 181.500 pajak
    // Total = Rp 1.831.500
    const breakdown = priceOf({
      supplierTotal: money(10_000, 'USD'),
      exchangeRate: USD_TO_IDR,
      markup: { kind: 'fixed', amount: money(50_000, 'IDR'), ruleId: 'r-2' },
      tax: PPN,
    })

    expect(breakdown.base.amountMinor).toBe(1_600_000)
    expect(breakdown.markup.amountMinor).toBe(50_000)
    expect(breakdown.tax.amountMinor).toBe(181_500)
    expect(breakdown.total.amountMinor).toBe(1_831_500)
  })

  test('tanpa markup dan tanpa pajak, harga jual sama dengan harga supplier', () => {
    const breakdown = priceOf()

    expect(breakdown.markup.amountMinor).toBe(0)
    expect(breakdown.tax.amountMinor).toBe(0)
    expect(breakdown.total.amountMinor).toBe(1_000_000)
  })
})

describe('pembulatan sekali di akhir', () => {
  test('rincian selalu menjumlah tepat ke totalnya', () => {
    // Rincian yang tidak menjumlah ke totalnya membuat pengguna berhenti
    // percaya pada angkanya.
    for (const amount of [1, 7, 999, 100_003, 1_234_567, 9_999_999]) {
      for (const markupBp of [0, 750, 1_250, 3_333]) {
        const breakdown = priceOf({
          supplierTotal: money(amount, 'IDR'),
          markup:
            markupBp === 0 ? NO_MARKUP : { kind: 'percentage', basisPoints: markupBp, ruleId: 'r' },
          tax: PPN,
        })

        const sum = add(add(breakdown.base, breakdown.markup), breakdown.tax)
        expect(sum.amountMinor).toBe(breakdown.total.amountMinor)
      }
    }
  })

  test('hasil berbeda dari perhitungan yang membulatkan di setiap langkah', () => {
    // Rp 1.005 dengan markup 7,5% lalu PPN 11%:
    //   sekali di akhir : 1005 × 1,075 = 1080,375 ; × 1,11 = 1199,21625 → 1199
    //   dibulatkan tiap langkah: 1080 ; × 1,11 = 1198,8 → 1199
    // Perbedaannya tidak selalu muncul — yang penting adalah angka yang benar
    // dihitung dari nilai yang belum dibulatkan.
    const breakdown = priceOf({
      supplierTotal: money(1_005, 'IDR'),
      markup: { kind: 'percentage', basisPoints: 750, ruleId: 'r-1' },
      tax: PPN,
    })

    expect(breakdown.total.amountMinor).toBe(1_199)
  })

  test('mode pembulatan diteruskan apa adanya', () => {
    const base = { supplierTotal: money(1_005, 'IDR'), tax: PPN } as const

    expect(priceOf({ ...base, rounding: 'down' }).total.amountMinor).toBe(1_115)
    expect(priceOf({ ...base, rounding: 'up' }).total.amountMinor).toBe(1_116)
  })
})

describe('perbedaan pembulatan IDR dan USD', () => {
  test('IDR dibulatkan ke rupiah penuh', () => {
    const breakdown = priceOf({ supplierTotal: money(1_001, 'IDR'), tax: PPN })

    // 1001 × 1,11 = 1111,11 → 1111
    expect(breakdown.total.amountMinor).toBe(1_111)
    expect(breakdown.total.currency).toBe('IDR')
  })

  test('USD dibulatkan ke sen', () => {
    const breakdown = priceOf({
      supplierTotal: money(1_001, 'USD'),
      sellingCurrency: 'USD',
      tax: PPN,
    })

    // $10,01 × 1,11 = $11,1111 → $11,11
    expect(breakdown.total.amountMinor).toBe(1_111)
    expect(breakdown.total.currency).toBe('USD')
  })
})

describe('kegagalan yang dilaporkan, bukan ditebak', () => {
  test('kurs yang hilang menggagalkan perhitungan', () => {
    // Menebak kurs, atau memakai 1:1, menghasilkan harga yang keliru ribuan
    // kali lipat dan terlihat masuk akal secara tipe.
    const result = calculatePrice({
      supplierTotal: money(10_000, 'USD'),
      sellingCurrency: 'IDR',
      markup: NO_MARKUP,
      tax: PPN,
      rounding: 'half_even',
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('missing_exchange_rate')
  })

  test('kurs yang arahnya terbalik ditolak', () => {
    const result = calculatePrice({
      supplierTotal: money(10_000, 'USD'),
      sellingCurrency: 'IDR',
      exchangeRate: { ...USD_TO_IDR, from: 'IDR', to: 'USD' },
      markup: NO_MARKUP,
      tax: PPN,
      rounding: 'half_even',
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('wrong_exchange_rate')
  })

  test('markup nominal dalam mata uang yang salah ditolak', () => {
    // Operator yang menetapkan "Rp 50.000" untuk harga jual dolar sedang
    // salah memasukkan data, bukan meminta konversi.
    const result = calculatePrice({
      supplierTotal: money(10_000, 'USD'),
      sellingCurrency: 'USD',
      markup: { kind: 'fixed', amount: money(50_000, 'IDR'), ruleId: 'r-2' },
      tax: PPN,
      rounding: 'half_even',
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('markup_currency_mismatch')
  })
})

describe('rincian untuk transparansi biaya', () => {
  test('menyertakan harga supplier apa adanya', () => {
    const supplierTotal: Money = money(10_000, 'USD')
    const breakdown = priceOf({ supplierTotal, exchangeRate: USD_TO_IDR, tax: PPN })

    expect(breakdown.supplierTotal).toEqual(supplierTotal)
  })

  test('menyertakan kurs yang dipakai', () => {
    const breakdown = priceOf({
      supplierTotal: money(10_000, 'USD'),
      exchangeRate: USD_TO_IDR,
      tax: PPN,
    })

    expect(breakdown.exchangeRate?.rate.amount).toBe(16_000)
    expect(breakdown.exchangeRate?.asOf).toBe('2026-09-01T00:00:00.000Z')
  })

  test('menyertakan aturan markup yang diterapkan', () => {
    const breakdown = priceOf({
      markup: { kind: 'percentage', basisPoints: 1_500, ruleId: 'r-khusus' },
      tax: PPN,
    })

    expect(breakdown.appliedMarkupRuleId).toBe('r-khusus')
  })

  test('tanpa markup, tidak ada aturan yang disebut', () => {
    expect(priceOf().appliedMarkupRuleId).toBeUndefined()
  })

  test('menyebut nama pajaknya', () => {
    expect(priceOf({ tax: PPN }).taxName).toBe('PPN')
  })

  test('tanpa konversi, tidak ada kurs yang disebut', () => {
    expect(priceOf().exchangeRate).toBeUndefined()
  })
})
