import type { Metric } from './counters.js'
import { SUPPLIER_CODES } from './facts.js'

/**
 * Laporan analitik dari penghitung (Step 27) — fungsi murni.
 *
 * Rasio dinyatakan dalam basis poin (0–10_000) dan dihitung di sini, bukan di
 * panel: panel hanya menampilkan. Pembagian dengan nol menjadi `null`, bukan
 * 0 — "0% kegagalan" untuk hari tanpa pemesanan adalah klaim yang salah.
 */

export interface CounterRow {
  readonly metric: Metric
  readonly dimension: string
  readonly value: number
}

const BASIS_POINTS = 10_000

export const FUNNEL_STAGES = [
  ['search', 'funnel.search'],
  ['booking_created', 'funnel.booking_created'],
  ['held', 'funnel.held'],
  ['paid', 'funnel.paid'],
  ['confirmed', 'funnel.confirmed'],
] as const satisfies readonly (readonly [string, Metric])[]

export function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : Math.round((numerator * BASIS_POINTS) / denominator)
}

/** Penjumlahan per (metrik, dimensi) atas seluruh hari dalam rentang. */
class Totals {
  private readonly values = new Map<string, number>()

  constructor(rows: readonly CounterRow[]) {
    for (const row of rows) {
      const key = Totals.key(row.metric, row.dimension)
      this.values.set(key, (this.values.get(key) ?? 0) + row.value)
    }
  }

  private static key(metric: Metric, dimension: string): string {
    return `${metric}\u0000${dimension}`
  }

  get(metric: Metric, dimension = ''): number {
    return this.values.get(Totals.key(metric, dimension)) ?? 0
  }

  /** Seluruh dimensi satu metrik, terbesar lebih dulu, seri diurutkan menurut nama. */
  ranked(metric: Metric): { readonly dimension: string; readonly value: number }[] {
    const prefix = `${metric}\u0000`
    return [...this.values.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ dimension: key.slice(prefix.length), value }))
      .toSorted((a, b) => b.value - a.value || a.dimension.localeCompare(b.dimension))
  }
}

export function summarize(rows: readonly CounterRow[], top: number) {
  const totals = new Totals(rows)

  return {
    funnel: funnelOf(totals),
    search: searchOf(totals),
    suppliers: suppliersOf(totals),
    topCities: totals
      .ranked('city.searches')
      .slice(0, top)
      .map((entry) => ({ city: entry.dimension, searches: entry.value })),
    topStays: totals
      .ranked('stay.searches')
      .slice(0, top)
      .map((entry) => ({ ...stayParts(entry.dimension), searches: entry.value })),
    failures: failuresOf(totals, top),
    events: totals
      .ranked('event.count')
      .map((entry) => ({ type: entry.dimension, count: entry.value })),
  }
}

export type AnalyticsSummary = ReturnType<typeof summarize>

/**
 * Corong. "Lihat detail" dari prompt Step 27 TIDAK ada di sini: tidak ada
 * peristiwa yang mengumumkan halaman properti dibuka, dan menambahkannya
 * berarti mengubah search-service dan apps/web — tepat yang tidak boleh
 * dilakukan sebuah konsumen baru. Lihat Temuan Step 27.
 */
function funnelOf(totals: Totals) {
  return FUNNEL_STAGES.map(([stage, metric], index) => {
    const count = totals.get(metric)
    const previous = index === 0 ? undefined : FUNNEL_STAGES[index - 1]
    return {
      stage,
      count,
      fromPreviousBasisPoints:
        previous === undefined ? null : ratio(count, totals.get(previous[1])),
    }
  })
}

function searchOf(totals: Totals) {
  const count = totals.get('funnel.search')
  return {
    count,
    averageLatencyMs: count === 0 ? null : Math.round(totals.get('search.latency_ms_sum') / count),
    averageResults: count === 0 ? null : Math.round(totals.get('search.results_sum') / count),
    bySource: totals
      .ranked('search.source')
      .map((entry) => ({ source: entry.dimension, count: entry.value })),
  }
}

/**
 * Performa supplier dari peristiwa. LATENSI per supplier tidak ada di sini:
 * `search.performed` hanya membawa latensi seluruh pencarian. Latensi per
 * supplier dibaca langsung dari catatan percobaan supplier-service di halaman
 * kesehatan (`/ops/suppliers`).
 */
function suppliersOf(totals: Totals) {
  return [...SUPPLIER_CODES, 'UNKNOWN']
    .map((supplier) => {
      const responded = totals.get('supplier.search_responded', supplier)
      const timedOut = totals.get('supplier.search_timed_out', supplier)
      const unavailable = totals.get('supplier.search_unavailable', supplier)
      const created = totals.get('supplier.bookings_created', supplier)
      const priceChanged = totals.get('supplier.price_changed', supplier)
      return {
        supplier,
        searchesAsked: responded + timedOut + unavailable,
        searchesResponded: responded,
        searchesTimedOut: timedOut,
        searchesUnavailable: unavailable,
        responseRateBasisPoints: ratio(responded, responded + timedOut + unavailable),
        bookingsCreated: created,
        priceChanged,
        priceChangeRateBasisPoints: ratio(priceChanged, created),
        bookingsConfirmed: totals.get('supplier.booking_confirmed', supplier),
        bookingsFailed: totals.get('supplier.booking_failed', supplier),
        confirmRejected: totals.get('supplier.confirm_rejected', supplier),
        confirmUncertain: totals.get('supplier.confirm_uncertain', supplier),
        degradedTimes: totals.get('supplier.degraded', supplier),
      }
    })
    .filter((row) => row.supplier !== 'UNKNOWN' || row.priceChanged + row.bookingsFailed > 0)
}

/**
 * Membaca kembali dimensi gabungan. Kota tidak pernah memuat `|` (dibuang saat
 * dicatat, lihat counters.ts); tanggal tidak pernah memuatnya. Dimensi yang
 * rusak — baris yang disunting tangan — dibaca dengan bagian kosong, bukan
 * melempar dan menjatuhkan seluruh laporan.
 */
export function stayParts(dimension: string) {
  const pieces = dimension.split('|')
  return { city: pieces[0] ?? '', checkIn: pieces[1] ?? '', checkOut: pieces[2] ?? '' }
}

/** `tahap|alasan`. Alasan BOLEH memuat `|` (teks bebas dari penerbit), jadi sisanya digabung kembali. */
export function causeParts(dimension: string) {
  const [stage, ...reason] = dimension.split('|')
  return { stage: stage ?? '', reason: reason.join('|') }
}

function failuresOf(totals: Totals, top: number) {
  const created = totals.get('funnel.booking_created')
  const failed = totals.ranked('failure.booking').reduce((sum, entry) => sum + entry.value, 0)

  return {
    bookingsCreated: created,
    bookingsFailed: failed,
    failureRateBasisPoints: ratio(failed, created),
    byCause: totals
      .ranked('failure.booking')
      .slice(0, top)
      .map((entry) => ({ ...causeParts(entry.dimension), count: entry.value })),
    needingReview: totals
      .ranked('failure.review')
      .map((entry) => ({ stage: entry.dimension, count: entry.value })),
    payments: totals
      .ranked('failure.payment')
      .slice(0, top)
      .map((entry) => ({ reason: entry.dimension, count: entry.value })),
    cancellations: totals
      .ranked('cancel.reason')
      .map((entry) => ({ reason: entry.dimension, count: entry.value })),
  }
}
