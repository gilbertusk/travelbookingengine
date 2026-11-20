import { describe, expect, test } from 'vitest'
import {
  MAX_DIMENSION_LENGTH,
  UNKNOWN_SUPPLIER,
  dayOf,
  incrementsFor,
  mergeIncrements,
  type Increment,
} from './counters.js'
import type { AnalyticsFact } from './facts.js'

const AT = { occurredAt: '2026-10-25T23:30:00.000Z', eventType: 'x.y' }

function metricsOf(increments: readonly Increment[]): Record<string, number> {
  return Object.fromEntries(
    increments.map((increment) => [`${increment.metric}:${increment.dimension}`, increment.by]),
  )
}

const SEARCH: AnalyticsFact = {
  kind: 'search',
  city: '  Bali ',
  checkIn: '2026-11-10',
  checkOut: '2026-11-12',
  resultCount: 42,
  latencyMs: 812,
  source: 'live',
  responded: ['SKY', 'NOVA'],
  timedOut: ['ORBIT'],
  unavailable: ['LUNA'],
}

describe('incrementsFor', () => {
  test('setiap peristiwa dihitung per jenis — bukti seluruh topik terbaca', () => {
    const increments = incrementsFor(
      { kind: 'other' },
      { ...AT, eventType: 'voucher.issued' },
      undefined,
    )

    expect(increments).toEqual([
      { day: '2026-10-25', metric: 'event.count', dimension: 'voucher.issued', by: 1 },
    ])
  })

  test('pencarian: corong, latensi, hasil, sumber, kota ternormalisasi, rentang, dan supplier', () => {
    expect(metricsOf(incrementsFor(SEARCH, AT, undefined))).toEqual({
      'event.count:x.y': 1,
      'funnel.search:': 1,
      'search.latency_ms_sum:': 812,
      'search.results_sum:': 42,
      'search.source:live': 1,
      'city.searches:bali': 1,
      'stay.searches:bali|2026-11-10|2026-11-12': 1,
      'supplier.search_responded:SKY': 1,
      'supplier.search_responded:NOVA': 1,
      'supplier.search_timed_out:ORBIT': 1,
      'supplier.search_unavailable:LUNA': 1,
    })
  })

  test('pemisah dimensi di nama kota dibuang, supaya rentang tetap dapat dibaca kembali', () => {
    const fact: AnalyticsFact = { ...SEARCH, city: 'Ba|li' }

    expect(metricsOf(incrementsFor(fact, AT, undefined))).toHaveProperty(
      ['stay.searches:ba li|2026-11-10|2026-11-12'],
      1,
    )
  })

  test('alur pemesanan: setiap tahap corong dan supplier yang disebut peristiwanya', () => {
    const cases: readonly [AnalyticsFact, Record<string, number>][] = [
      [
        { kind: 'booking_created', bookingId: 'b', supplier: 'SKY' },
        { 'funnel.booking_created:': 1, 'supplier.bookings_created:SKY': 1 },
      ],
      [{ kind: 'booking_held', bookingId: 'b' }, { 'funnel.held:': 1 }],
      [{ kind: 'payment_succeeded', bookingId: 'b' }, { 'funnel.paid:': 1 }],
      [
        { kind: 'booking_confirmed', bookingId: 'b', supplier: 'NOVA' },
        { 'funnel.confirmed:': 1, 'supplier.booking_confirmed:NOVA': 1 },
      ],
      [
        { kind: 'booking_cancelled', bookingId: 'b', reason: 'hold_expired' },
        { 'cancel.reason:hold_expired': 1 },
      ],
      [
        { kind: 'payment_failed', bookingId: 'b', reason: 'card_declined' },
        { 'failure.payment:card_declined': 1 },
      ],
      [{ kind: 'supplier_degraded', supplier: 'ZEPH' }, { 'supplier.degraded:ZEPH': 1 }],
      [
        { kind: 'supplier_confirm', supplier: 'SKY', outcome: 'uncertain' },
        { 'supplier.confirm_uncertain:SKY': 1 },
      ],
    ]

    for (const [fact, expected] of cases) {
      expect(metricsOf(incrementsFor(fact, AT, undefined))).toEqual({
        'event.count:x.y': 1,
        ...expected,
      })
    }
  })

  test('perubahan harga memakai supplier dari pemetaan, atau UNKNOWN', () => {
    const changed: AnalyticsFact = { kind: 'price_changed', bookingId: 'b' }

    expect(metricsOf(incrementsFor(changed, AT, 'LUNA'))).toHaveProperty(
      ['supplier.price_changed:LUNA'],
      1,
    )
    expect(metricsOf(incrementsFor(changed, AT, undefined))).toHaveProperty(
      [`supplier.price_changed:${UNKNOWN_SUPPLIER}`],
      1,
    )
  })

  test('kegagalan: sebab `tahap|alasan`, dan tinjauan manual dihitung terpisah', () => {
    const failed: AnalyticsFact = {
      kind: 'booking_failed',
      bookingId: 'b',
      stage: 'supplier_confirm',
      reason: 'sold_out',
      requiresManualReview: true,
    }

    expect(metricsOf(incrementsFor(failed, AT, 'SKY'))).toEqual({
      'event.count:x.y': 1,
      'failure.booking:supplier_confirm|sold_out': 1,
      'supplier.booking_failed:SKY': 1,
      'failure.review:supplier_confirm': 1,
    })
    expect(
      metricsOf(incrementsFor({ ...failed, requiresManualReview: false }, AT, 'SKY')),
    ).not.toHaveProperty(['failure.review:supplier_confirm'])
  })

  test('dimensi teks bebas dipotong, tidak menjadi kardinalitas tak terbatas', () => {
    const reason = 'x'.repeat(500)
    const [, cause] = incrementsFor(
      { kind: 'payment_failed', bookingId: 'b', reason },
      AT,
      undefined,
    )

    expect(cause?.dimension).toHaveLength(MAX_DIMENSION_LENGTH)
  })
})

describe('dayOf', () => {
  test('tanggal UTC dari waktu peristiwa, termasuk zona selain Z', () => {
    expect(dayOf('2026-10-25T23:59:59.999Z')).toBe('2026-10-25')
    // 06:00 di Jakarta (+07:00) masih tanggal 24 di UTC.
    expect(dayOf('2026-10-25T06:00:00+07:00')).toBe('2026-10-24')
  })
})

describe('mergeIncrements', () => {
  test('kunci yang sama dijumlahkan, kunci berbeda dipertahankan, masukan tidak diubah', () => {
    const one: Increment = {
      day: '2026-10-25',
      metric: 'supplier.search_responded',
      dimension: 'SKY',
      by: 1,
    }
    const input = [one, { ...one }, { ...one, dimension: 'NOVA' }, { ...one, day: '2026-10-26' }]

    expect(mergeIncrements(input)).toEqual([
      { ...one, by: 2 },
      { ...one, dimension: 'NOVA' },
      { ...one, day: '2026-10-26' },
    ])
    expect(input[0]?.by).toBe(1)
  })
})
