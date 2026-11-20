import { describe, expect, test } from 'vitest'
import { causeParts, ratio, stayParts, summarize, type CounterRow } from './summary.js'

const row = (metric: CounterRow['metric'], value: number, dimension = ''): CounterRow => ({
  metric,
  dimension,
  value,
})

describe('summarize', () => {
  test('kosong: corong nol dengan rasio null, bukan 0% — tidak ada yang dapat dibagi', () => {
    const summary = summarize([], 10)

    expect(summary.funnel.map((stage) => stage.count)).toEqual([0, 0, 0, 0, 0])
    expect(summary.funnel.map((stage) => stage.fromPreviousBasisPoints)).toEqual([
      null,
      null,
      null,
      null,
      null,
    ])
    expect(summary.search.averageLatencyMs).toBeNull()
    expect(summary.failures.failureRateBasisPoints).toBeNull()
    expect(summary.suppliers.map((supplier) => supplier.supplier)).toEqual([
      'SKY',
      'NOVA',
      'ORBIT',
      'LUNA',
      'ZEPH',
    ])
  })

  test('corong menjumlahkan lintas hari dan menghitung konversi dari tahap sebelumnya', () => {
    const summary = summarize(
      [
        row('funnel.search', 600),
        row('funnel.search', 400),
        row('funnel.booking_created', 100),
        row('funnel.held', 50),
        row('funnel.paid', 40),
        row('funnel.confirmed', 38),
      ],
      10,
    )

    expect(summary.funnel).toEqual([
      { stage: 'search', count: 1_000, fromPreviousBasisPoints: null },
      { stage: 'booking_created', count: 100, fromPreviousBasisPoints: 1_000 },
      { stage: 'held', count: 50, fromPreviousBasisPoints: 5_000 },
      { stage: 'paid', count: 40, fromPreviousBasisPoints: 8_000 },
      { stage: 'confirmed', count: 38, fromPreviousBasisPoints: 9_500 },
    ])
  })

  test('pencarian: rata-rata latensi dan hasil, sumber terbanyak lebih dulu', () => {
    const summary = summarize(
      [
        row('funnel.search', 4),
        row('search.latency_ms_sum', 2_000),
        row('search.results_sum', 10),
        row('search.source', 1, 'cache'),
        row('search.source', 3, 'live'),
      ],
      10,
    )

    expect(summary.search).toEqual({
      count: 4,
      averageLatencyMs: 500,
      averageResults: 3,
      bySource: [
        { source: 'live', count: 3 },
        { source: 'cache', count: 1 },
      ],
    })
  })

  test('supplier: tingkat respons, tingkat perubahan harga, dan UNKNOWN hanya bila ada isinya', () => {
    const summary = summarize(
      [
        row('supplier.search_responded', 8, 'SKY'),
        row('supplier.search_timed_out', 1, 'SKY'),
        row('supplier.search_unavailable', 1, 'SKY'),
        row('supplier.bookings_created', 4, 'SKY'),
        row('supplier.price_changed', 1, 'SKY'),
        row('supplier.price_changed', 2, 'UNKNOWN'),
      ],
      10,
    )

    const sky = summary.suppliers.find((supplier) => supplier.supplier === 'SKY')
    expect(sky).toMatchObject({
      searchesAsked: 10,
      responseRateBasisPoints: 8_000,
      priceChangeRateBasisPoints: 2_500,
    })
    expect(summary.suppliers.at(-1)).toMatchObject({ supplier: 'UNKNOWN', priceChanged: 2 })
  })

  test('kota dan rentang terpopuler dibatasi `top`, seri diurutkan menurut nama', () => {
    const summary = summarize(
      [
        row('city.searches', 5, 'jakarta'),
        row('city.searches', 5, 'bali'),
        row('city.searches', 1, 'medan'),
        row('stay.searches', 3, 'bali|2026-11-10|2026-11-12'),
      ],
      2,
    )

    expect(summary.topCities).toEqual([
      { city: 'bali', searches: 5 },
      { city: 'jakarta', searches: 5 },
    ])
    expect(summary.topStays).toEqual([
      { city: 'bali', checkIn: '2026-11-10', checkOut: '2026-11-12', searches: 3 },
    ])
  })

  test('kegagalan: tingkat terhadap pemesanan dibuat, sebab, tinjauan, pembayaran, pembatalan', () => {
    const summary = summarize(
      [
        row('funnel.booking_created', 20),
        row('failure.booking', 3, 'supplier_confirm|sold_out'),
        row('failure.booking', 1, 'payment|gateway|timeout'),
        row('failure.review', 1, 'supplier_confirm'),
        row('failure.payment', 2, 'card_declined'),
        row('cancel.reason', 4, 'hold_expired'),
      ],
      10,
    )

    expect(summary.failures).toEqual({
      bookingsCreated: 20,
      bookingsFailed: 4,
      failureRateBasisPoints: 2_000,
      byCause: [
        { stage: 'supplier_confirm', reason: 'sold_out', count: 3 },
        { stage: 'payment', reason: 'gateway|timeout', count: 1 },
      ],
      needingReview: [{ stage: 'supplier_confirm', count: 1 }],
      payments: [{ reason: 'card_declined', count: 2 }],
      cancellations: [{ reason: 'hold_expired', count: 4 }],
    })
  })

  test('jumlah peristiwa per jenis', () => {
    expect(summarize([row('event.count', 7, 'search.performed')], 10).events).toEqual([
      { type: 'search.performed', count: 7 },
    ])
  })
})

describe('pembacaan dimensi gabungan', () => {
  test('dimensi yang rusak dibaca dengan bagian kosong, tidak melempar', () => {
    expect(stayParts('bali')).toEqual({ city: 'bali', checkIn: '', checkOut: '' })
    expect(causeParts('')).toEqual({ stage: '', reason: '' })
  })

  test('ratio: basis poin dibulatkan, pembagi nol menjadi null', () => {
    expect(ratio(1, 3)).toBe(3_333)
    expect(ratio(1, 0)).toBeNull()
  })
})
