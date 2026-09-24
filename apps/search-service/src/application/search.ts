import type { SupplierCode, SupplierSearchResult } from '@tbe/supplier-adapters'
import {
  cityTag,
  normalize,
  resultCacheKey,
  supplierCacheKey,
  type SearchCriteria,
} from '../domain/criteria.js'
import {
  applyFilters,
  mergeResults,
  sortProperties,
  type MergedProperty,
  type Offer,
  type UnmappedSighting,
} from '../domain/merge.js'
import { fanOut, type DeadlineFactory, type SupplierCall, type SupplierOutcome } from './fan-out.js'
import type { PricedItem, SearchDeps, SupplierStatus } from './ports.js'
import type { SightingBuffer } from './resolve-properties.js'

/**
 * Orkestrator pencarian.
 *
 * Urutannya tetap dan disengaja:
 *
 *   cache lapis 1 → single-flight → cache lapis 2 per supplier →
 *   fan-out beranggaran → gabung & dedup → harga → saring & urutkan
 *
 * Yang paling mudah salah di sini adalah menaruh penetapan harga sebelum
 * penyaringan. Menetapkan harga untuk tawaran yang kemudian dibuang berarti
 * membayar perhitungan yang tidak dipakai — tetapi menyaring lebih dulu
 * mustahil, karena penyaring harga bekerja pada harga JUAL, dan harga jual
 * belum ada sebelum pricing-service menghitungnya.
 */

export interface SearchResponse {
  readonly properties: readonly PricedProperty[]
  readonly meta: SearchMeta
}

export interface PricedProperty extends Omit<MergedProperty, 'offers'> {
  readonly offers: readonly PricedOffer[]
  /** Harga jual terendah. Inilah yang ditampilkan di kartu hasil. */
  readonly lowestTotal: PricedOffer['total']
}

export interface PricedOffer extends Omit<Offer, 'supplierTotal'> {
  readonly total: PricedItem['total']
  readonly base: PricedItem['base']
  readonly markup: PricedItem['markup']
  readonly tax: PricedItem['tax']
  readonly taxName: string
}

export interface SearchMeta {
  readonly source: 'cache' | 'live' | 'partial_cache'
  /** Umur data bila berasal dari cache. */
  readonly ageMs?: number | undefined
  readonly suppliersResponded: readonly SupplierCode[]
  readonly suppliersTimedOut: readonly SupplierCode[]
  readonly suppliersUnavailable: readonly SupplierCode[]
  readonly latencyMs: number
  /** True bila ada supplier yang tidak berkontribusi. Dipakai PartialResultNotice. */
  readonly partial: boolean
}

export interface SearchOptions {
  readonly deadline: DeadlineFactory
  readonly sightings: SightingBuffer
  readonly onLateError: (supplier: SupplierCode | 'cache', error: unknown) => void
}

export async function search(
  deps: SearchDeps,
  raw: SearchCriteria,
  options: SearchOptions,
): Promise<SearchResponse> {
  const criteria = normalize(raw)
  const startedAt = deps.clock.now()
  const key = resultCacheKey(criteria)

  const cached = await deps.results.read(key)
  if (cached !== undefined) {
    deps.metrics.cacheHit('results')

    const response = fromCache(cached.payload, cached.ageMs, deps.clock.now() - startedAt)
    await publish(deps, criteria, response)

    return response
  }

  deps.metrics.cacheMiss('results')

  // Single-flight: seratus permintaan serentak untuk kunci yang sama hanya
  // memicu SATU fan-out. Yang lain menunggu jawaban yang sama.
  const response = await deps.singleFlight.run(key, async () => {
    // Diperiksa lagi di dalam kunci. Pemanggil yang menunggu di antrian
    // kunci mungkin masuk tepat setelah pemenangnya selesai menulis cache,
    // dan memaksanya mengulang fan-out membuang seluruh gunanya menunggu.
    const filled = await deps.results.read(key)
    if (filled !== undefined) {
      deps.metrics.cacheHit('results')
      return fromCache(filled.payload, filled.ageMs, deps.clock.now() - startedAt)
    }

    return await runLive(deps, criteria, options, startedAt)
  })

  await publish(deps, criteria, response)

  return response
}

async function runLive(
  deps: SearchDeps,
  criteria: SearchCriteria,
  options: SearchOptions,
  startedAt: number,
): Promise<SearchResponse> {
  const directory = await deps.suppliers.directory()
  const { callable, skipped } = partition(directory)

  const calls = callable.map((supplier) => toCall(deps, supplier, criteria))

  const run = await fanOut(calls, {
    budgetMs: deps.settings.budgetMs,
    deadline: options.deadline,
    onLate: (result) => {
      // Jawaban yang terlambat disimpan untuk pencarian berikutnya. Tanpa ini
      // supplier lambat tidak pernah berkontribusi sama sekali.
      void deps.supplierResults
        .write(supplierCacheKey(result.supplier, criteria), result)
        .catch((error: unknown) => {
          options.onLateError(result.supplier, error)
        })
    },
    onLateError: options.onLateError,
    skipped,
  })

  const response = await assemble(deps, {
    criteria,
    results: run.results,
    outcomes: run.outcomes,
    options,
    startedAt,
  })

  await deps.results
    .write(
      resultCacheKey(criteria),
      {
        payload: response,
        suppliers: response.meta.suppliersResponded,
        storedAtMs: deps.clock.now(),
      },
      cityTag(criteria),
    )
    .catch((error: unknown) => {
      // Cache yang gagal ditulis tidak menggagalkan pencarian yang sudah
      // berhasil dihitung. Yang hilang hanya keuntungan pencarian berikutnya.
      options.onLateError('cache', error)
    })

  return response
}

/**
 * Memanggil satu supplier, lewat cache lapis kedua lebih dulu.
 *
 * Cache lapis kedua inilah yang memanen jawaban supplier lambat dari
 * pencarian sebelumnya. Ia juga alasan pemulihan satu supplier tidak
 * membatalkan seluruh cache: yang kedaluwarsa hanya entri supplier itu.
 */
function toCall(deps: SearchDeps, supplier: SupplierCode, criteria: SearchCriteria): SupplierCall {
  return {
    supplier,
    run: async () => {
      const key = supplierCacheKey(supplier, criteria)
      const cached = await deps.supplierResults.read(key)

      if (cached !== undefined) {
        deps.metrics.cacheHit('supplier')
        return cached
      }

      deps.metrics.cacheMiss('supplier')

      const result = await deps.suppliers.search(supplier, {
        city: criteria.city,
        checkIn: criteria.checkIn,
        checkOut: criteria.checkOut,
        guests: criteria.guests,
      })

      await deps.supplierResults.write(key, result)

      return result
    },
  }
}

function partition(directory: readonly SupplierStatus[]): {
  callable: readonly SupplierCode[]
  skipped: readonly { supplier: SupplierCode; reason: 'circuit_open' | 'inactive' }[]
} {
  const callable: SupplierCode[] = []
  const skipped: { supplier: SupplierCode; reason: 'circuit_open' | 'inactive' }[] = []

  for (const status of directory) {
    if (!status.isActive) {
      skipped.push({ supplier: status.supplier, reason: 'inactive' })
      continue
    }

    // Pemutus terbuka berarti supplier ini sudah terbukti tumbang. Memanggilnya
    // tetap menghabiskan satu slot anggaran dan satu perjalanan jaringan untuk
    // jawaban yang sudah diketahui.
    if (status.circuit === 'open') {
      skipped.push({ supplier: status.supplier, reason: 'circuit_open' })
      continue
    }

    callable.push(status.supplier)
  }

  return { callable, skipped }
}

interface Assembly {
  readonly criteria: SearchCriteria
  readonly results: readonly SupplierSearchResult[]
  readonly outcomes: readonly SupplierOutcome[]
  readonly options: SearchOptions
  readonly startedAt: number
}

async function assemble(deps: SearchDeps, run: Assembly): Promise<SearchResponse> {
  const { criteria, results, outcomes, options, startedAt } = run
  const catalog = deps.catalog()
  const merged = mergeResults(results, catalog ?? EMPTY_CATALOG)

  record(options.sightings, merged.unmapped)

  const filtered = applyFilters(merged.properties, criteria)
  const priced = await priceAll(deps, criteria, filtered)
  const withinBudget = priced.filter((property) => matchesBudget(property, criteria))

  return {
    properties: sortProperties(withinBudget, criteria, lowestOf),
    meta: metaOf(outcomes, 'live', undefined, deps.clock.now() - startedAt),
  }
}

/**
 * Katalog kosong sebagai cadangan.
 *
 * Katalog yang belum termuat membuat setiap properti tampil sebagai belum
 * terpetakan — hasil yang buruk, tetapi jauh lebih baik daripada pencarian
 * yang gagal seluruhnya. Kesiapan service sudah bergantung pada katalog, jadi
 * keadaan ini seharusnya tidak pernah terjadi pada instance yang menerima
 * trafik; cadangan ini ada untuk keadaan yang seharusnya tidak terjadi.
 */
const EMPTY_CATALOG = {
  propertyId: () => undefined,
  property: () => undefined,
}

function record(buffer: SightingBuffer, sightings: readonly UnmappedSighting[]): void {
  for (const sighting of sightings) {
    buffer.add({
      supplierId: sighting.supplierId,
      supplierPropertyId: sighting.supplierPropertyId,
      name: sighting.name,
      ...(sighting.address === undefined ? {} : { address: sighting.address }),
      ...(sighting.city === undefined ? {} : { city: sighting.city }),
      ...(sighting.latitude === undefined ? {} : { latitude: sighting.latitude }),
      ...(sighting.longitude === undefined ? {} : { longitude: sighting.longitude }),
    })
  }
}

/**
 * Menetapkan harga SELURUH tawaran dalam satu panggilan.
 *
 * Satu panggilan untuk ratusan tawaran, bukan satu panggilan per tawaran.
 * Yang kedua akan menghasilkan ratusan perjalanan jaringan di jalur yang
 * paling sensitif terhadap waktu, dan pricing-service sendiri sudah dibangun
 * untuk menerima ratusan sekaligus tanpa kueri berulang.
 *
 * Harga yang dikembalikan ke klien SELALU harga jual. Tawaran yang gagal
 * dihitung harganya dibuang, bukan dikembalikan dengan harga supplier —
 * menampilkan harga supplier berarti menjual tanpa markup.
 */
async function priceAll(
  deps: SearchDeps,
  criteria: SearchCriteria,
  properties: readonly MergedProperty[],
): Promise<readonly PricedProperty[]> {
  const items = properties.flatMap((property) =>
    property.offers.map((offer) => ({
      ref: offerRef(property.ref, offer),
      supplier: offer.supplier,
      city: criteria.city,
      supplierTotal: offer.supplierTotal,
    })),
  )

  if (items.length === 0) return []

  const priced = new Map((await deps.pricing.price(items)).map((item) => [item.ref, item]))

  return properties.flatMap((property) => {
    const offers = property.offers.flatMap((offer) => {
      const price = priced.get(offerRef(property.ref, offer))
      if (price === undefined) return []

      return [toPricedOffer(offer, price)]
    })

    const lowest = offers[0]
    if (lowest === undefined) return []

    return [{ ...property, offers, lowestTotal: lowest.total }]
  })
}

/**
 * Tawaran dengan harga JUAL, tanpa harga supplier.
 *
 * `supplierTotal` sengaja tidak ikut. Bidang yang tidak ada tidak dapat
 * dikirim ke klien tanpa sengaja — dan harga supplier yang bocor ke klien
 * berarti membocorkan margin.
 */
function toPricedOffer(offer: Offer, price: PricedItem): PricedOffer {
  return {
    supplier: offer.supplier,
    supplierPropertyId: offer.supplierPropertyId,
    supplierRatePlanId: offer.supplierRatePlanId,
    roomTypeName: offer.roomTypeName,
    ratePlanName: offer.ratePlanName,
    refundable: offer.refundable,
    ...(offer.freeCancellationDays === undefined
      ? {}
      : { freeCancellationDays: offer.freeCancellationDays }),
    breakfastIncluded: offer.breakfastIncluded,
    unitsLeft: offer.unitsLeft,
    total: price.total,
    base: price.base,
    markup: price.markup,
    tax: price.tax,
    taxName: price.taxName,
  }
}

function offerRef(propertyRef: string, offer: Offer): string {
  return `${propertyRef}|${offer.supplier}|${offer.supplierRatePlanId}`
}

/**
 * Penyaring harga bekerja pada harga JUAL, bukan harga supplier.
 *
 * Itu sebabnya ia diterapkan setelah penetapan harga. Menyaring pada harga
 * supplier akan membuang tawaran yang sebenarnya masuk anggaran pengguna, dan
 * menyisakan tawaran yang setelah markup justru melewatinya.
 */
function matchesBudget(property: PricedProperty, criteria: SearchCriteria): boolean {
  if (criteria.maxTotalMinor === undefined) return true

  return property.lowestTotal.amountMinor <= criteria.maxTotalMinor
}

function lowestOf(property: PricedProperty): number {
  return property.lowestTotal.amountMinor
}

function metaOf(
  outcomes: readonly SupplierOutcome[],
  source: SearchMeta['source'],
  ageMs: number | undefined,
  latencyMs: number,
): SearchMeta {
  const responded = outcomes
    .filter((item) => item.kind === 'responded')
    .map((item) => item.supplier)
  const timedOut = outcomes.filter((item) => item.kind === 'timed_out').map((item) => item.supplier)
  const unavailable = outcomes
    .filter((item) => item.kind === 'failed' || item.kind === 'skipped')
    .map((item) => item.supplier)

  return {
    source,
    ...(ageMs === undefined ? {} : { ageMs }),
    suppliersResponded: responded,
    suppliersTimedOut: timedOut,
    suppliersUnavailable: unavailable,
    latencyMs,
    partial: timedOut.length > 0 || unavailable.length > 0,
  }
}

function fromCache(payload: unknown, ageMs: number, latencyMs: number): SearchResponse {
  const stored = payload as SearchResponse

  return {
    properties: stored.properties,
    // Respons dari cache MENANDAI DIRINYA beserta umurnya. Klien yang tidak
    // tahu datanya berumur empat menit tidak dapat memutuskan apa pun
    // tentangnya — dan DESIGN-SYSTEM.md mewajibkan umur itu ditampilkan.
    meta: { ...stored.meta, source: 'cache', ageMs, latencyMs },
  }
}

async function publish(
  deps: SearchDeps,
  criteria: SearchCriteria,
  response: SearchResponse,
): Promise<void> {
  // Tidak ada data pribadi: tidak ada userId, tidak ada alamat surel, tidak
  // ada alamat IP. Topiknya beretensi pendek dan dibaca analitik.
  await deps.events.performed({
    city: criteria.city,
    checkIn: criteria.checkIn,
    checkOut: criteria.checkOut,
    guests: criteria.guests,
    resultCount: response.properties.length,
    latencyMs: response.meta.latencyMs,
    source: response.meta.source,
    suppliersResponded: response.meta.suppliersResponded,
    suppliersTimedOut: response.meta.suppliersTimedOut,
    suppliersUnavailable: response.meta.suppliersUnavailable,
  })
}
