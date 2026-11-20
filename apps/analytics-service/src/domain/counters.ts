import type { AnalyticsFact, SupplierCode } from './facts.js'

/**
 * Agregat sebagai penghitung (Step 27).
 *
 * Seluruh agregat disimpan dalam SATU bentuk: `(hari, metrik, dimensi) → nilai`.
 * Corong, performa supplier, kota terpopuler, dan sebab kegagalan semuanya
 * penjumlahan, jadi semuanya penghitung. Konsekuensi yang dicari:
 *
 * - Satu peristiwa = satu transaksi berisi beberapa INSERT ... ON CONFLICT
 *   DO UPDATE SET value = value + n. Atomik terhadap instance lain tanpa
 *   kunci di kode.
 * - Replay = kosongkan satu tabel, baca ulang topik. Tidak ada skema agregat
 *   per laporan yang harus dibangun ulang dengan urutan tertentu.
 * - Laporan baru yang hanya menggabungkan penghitung yang ada tidak butuh
 *   migrasi; yang butuh penghitung baru butuh replay — dan replay murah.
 *
 * Alternatif yang ditolak: tabel per laporan (funnel_daily, supplier_daily,
 * ...). Lebih "bertipe", tetapi setiap laporan baru menjadi migrasi plus
 * logika replay sendiri, untuk data yang bentuknya memang sama. ClickHouse
 * ditolak lebih awal oleh PRD Bab 12.
 *
 * Hari = tanggal UTC dari `occurredAt` peristiwa, bukan waktu diproses. Replay
 * yang berjalan sebulan kemudian harus menaruh setiap peristiwa di hari yang
 * sama dengan pemrosesan pertamanya — kalau tidak, replay bukan pembangunan
 * ULANG, melainkan pembangunan yang lain.
 */

export const METRICS = [
  'funnel.search',
  'funnel.booking_created',
  'funnel.held',
  'funnel.paid',
  'funnel.confirmed',
  'search.latency_ms_sum',
  'search.results_sum',
  'search.source',
  'city.searches',
  'stay.searches',
  'supplier.search_responded',
  'supplier.search_timed_out',
  'supplier.search_unavailable',
  'supplier.bookings_created',
  'supplier.price_changed',
  'supplier.booking_confirmed',
  'supplier.booking_failed',
  'supplier.confirm_confirmed',
  'supplier.confirm_rejected',
  'supplier.confirm_uncertain',
  'supplier.degraded',
  'failure.booking',
  'failure.review',
  'failure.payment',
  'cancel.reason',
  'event.count',
] as const

export type Metric = (typeof METRICS)[number]

export interface Increment {
  /** YYYY-MM-DD, UTC. */
  readonly day: string
  readonly metric: Metric
  /** '' untuk metrik tanpa dimensi. Bukan null: NULL tidak pernah sama dengan NULL di kunci UNIK. */
  readonly dimension: string
  readonly by: number
}

/**
 * Dimensi teks bebas (alasan kegagalan, nama kota) dibatasi panjangnya.
 * Alasan yang memuat pesan galat panjang akan menjadi dimensi berkardinalitas
 * tak terbatas; dipotong, ia tetap terbaca dan tetap terkelompok.
 */
export const MAX_DIMENSION_LENGTH = 120

/** Pengganti supplier yang tidak diketahui — booking.created tidak pernah terbaca. */
export const UNKNOWN_SUPPLIER = 'UNKNOWN'

export interface Occurrence {
  /** ISO-8601 dari amplop peristiwa. */
  readonly occurredAt: string
  readonly eventType: string
}

/**
 * Penghitung yang naik karena satu peristiwa.
 *
 * `supplierOf` hanya dipakai fakta yang tidak menyebut suppliernya sendiri
 * (perubahan harga, kegagalan pemesanan); diisi lapisan aplikasi dari
 * pemetaan bookingId → supplier yang dicatat saat booking.created.
 */
export function incrementsFor(
  fact: AnalyticsFact,
  occurrence: Occurrence,
  supplierOf: SupplierCode | undefined,
): readonly Increment[] {
  const day = dayOf(occurrence.occurredAt)
  const count = (metric: Metric, dimension = '', by = 1): Increment => ({
    day,
    metric,
    dimension: dimension.slice(0, MAX_DIMENSION_LENGTH),
    by,
  })
  const supplier = supplierOf ?? UNKNOWN_SUPPLIER

  return [count('event.count', occurrence.eventType), ...factIncrements(fact, count, supplier)]
}

type Count = (metric: Metric, dimension?: string, by?: number) => Increment

function factIncrements(fact: AnalyticsFact, count: Count, supplier: string): Increment[] {
  switch (fact.kind) {
    case 'search':
      return searchIncrements(fact, count)
    case 'booking_created':
      return [count('funnel.booking_created'), count('supplier.bookings_created', fact.supplier)]
    case 'booking_held':
      return [count('funnel.held')]
    case 'price_changed':
      return [count('supplier.price_changed', supplier)]
    case 'booking_confirmed':
      return [count('funnel.confirmed'), count('supplier.booking_confirmed', fact.supplier)]
    case 'booking_failed':
      return [
        count('failure.booking', `${fact.stage}|${fact.reason}`),
        count('supplier.booking_failed', supplier),
        ...(fact.requiresManualReview ? [count('failure.review', fact.stage)] : []),
      ]
    case 'booking_cancelled':
      return [count('cancel.reason', fact.reason)]
    case 'payment_succeeded':
      return [count('funnel.paid')]
    case 'payment_failed':
      return [count('failure.payment', fact.reason)]
    case 'supplier_degraded':
      return [count('supplier.degraded', fact.supplier)]
    case 'supplier_confirm':
      return [count(`supplier.confirm_${fact.outcome}`, fact.supplier)]
    case 'other':
      return []
  }
}

function searchIncrements(
  fact: Extract<AnalyticsFact, { kind: 'search' }>,
  count: Count,
): Increment[] {
  // Kota dinormalisasi: "Bali", "bali", dan " Bali " adalah kota yang sama
  // bagi operator yang membaca "kota terpopuler". `|` dibuang karena menjadi
  // pemisah dimensi `stay.searches`; kota datang dari masukan pengguna.
  const city = fact.city.trim().toLowerCase().replaceAll('|', ' ')

  return [
    count('funnel.search'),
    count('search.latency_ms_sum', '', fact.latencyMs),
    count('search.results_sum', '', fact.resultCount),
    count('search.source', fact.source),
    count('city.searches', city),
    count('stay.searches', `${city}|${fact.checkIn}|${fact.checkOut}`),
    ...fact.responded.map((code) => count('supplier.search_responded', code)),
    ...fact.timedOut.map((code) => count('supplier.search_timed_out', code)),
    ...fact.unavailable.map((code) => count('supplier.search_unavailable', code)),
  ]
}

/**
 * Tanggal UTC. Lewat `Date`, bukan memotong string: waktu dengan zona selain
 * `Z` (mis. `+07:00`) harus jatuh di tanggal UTC-nya, bukan tanggal lokalnya.
 */
export function dayOf(occurredAt: string): string {
  return new Date(occurredAt).toISOString().slice(0, 10)
}

/**
 * Satu penambahan per kunci. Pencarian yang menyebut supplier yang sama dua
 * kali di satu daftar (tidak seharusnya, tetapi payload adalah masukan luar)
 * menjadi satu penambahan +2, bukan dua pernyataan atas baris yang sama dalam
 * satu transaksi.
 */
export function mergeIncrements(increments: readonly Increment[]): Increment[] {
  const byKey = new Map<string, Increment>()
  for (const increment of increments) {
    const key = `${increment.day}\u0000${increment.metric}\u0000${increment.dimension}`
    const existing = byKey.get(key)
    byKey.set(
      key,
      existing === undefined ? increment : { ...existing, by: existing.by + increment.by },
    )
  }
  return [...byKey.values()]
}
