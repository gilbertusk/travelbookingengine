import { money } from '@tbe/money'
import type { SupplierCode, SupplierProperty, SupplierSearchResult } from '@tbe/supplier-adapters'
import type { Deadline } from '../application/fan-out.js'
import type {
  CachedResult,
  CachedResultBody,
  PricedItem,
  PricingGateway,
  PricingRequestItem,
  ResultCache,
  SearchDeps,
  SearchEvents,
  SearchMetrics,
  SearchPerformedPayload,
  SingleFlight,
  SupplierGateway,
  SupplierResultCache,
  SupplierStatus,
} from '../application/ports.js'
import { toSnapshot } from '../infrastructure/redis-catalog.js'
import { mapping, property } from './fakes.js'

/**
 * Perkakas uji jalur pencarian.
 *
 * Dua hal yang dijaga bentuknya di sini, dan keduanya syarat dari Step 13:
 *
 *   `pricing.calls` — penetapan harga terjadi SEKALI untuk seluruh hasil
 *   `gateway.searched` — fan-out terjadi sekali meski seratus permintaan masuk
 *
 * Keduanya hanya dapat dibuktikan dengan menghitung. Mengukur waktu akan
 * lulus pada mesin cepat meski setiap tawaran memicu panggilan sendiri.
 */

export const PADMA = property({
  id: 'prop-padma',
  slug: 'padma-bali-boutique-hotel',
  starRating: 4,
})
export const WIJAYA = property({
  id: 'prop-wijaya',
  slug: 'wijaya-bali-grand-hotel',
  name: 'Wijaya Bali Grand Hotel',
  starRating: 3,
})

export const CATALOG = toSnapshot({
  properties: [PADMA, WIJAYA],
  mappings: [
    mapping({ supplierId: 'SKY', supplierPropertyId: 'sky-padma', propertyId: 'prop-padma' }),
    mapping({ supplierId: 'NOVA', supplierPropertyId: 'nova-padma', propertyId: 'prop-padma' }),
    mapping({ supplierId: 'LUNA', supplierPropertyId: 'luna-padma', propertyId: 'prop-padma' }),
    mapping({ supplierId: 'SKY', supplierPropertyId: 'sky-wijaya', propertyId: 'prop-wijaya' }),
  ],
})

export function supplierProperty(
  supplierPropertyId: string,
  totalMinor = 1_000_000,
  overrides: Partial<SupplierProperty> = {},
): SupplierProperty {
  return {
    supplier: 'SKY',
    supplierPropertyId,
    name: 'Nama Versi Supplier',
    amenities: ['pool', 'wifi'],
    roomTypes: [
      {
        supplierRoomTypeId: `${supplierPropertyId}-rt`,
        name: 'Deluxe',
        ratePlans: [
          {
            supplierRatePlanId: `${supplierPropertyId}-rp`,
            name: 'Refundable with Breakfast',
            total: money(totalMinor, 'IDR'),
            nightly: money(Math.round(totalMinor / 2), 'IDR'),
            cancellationPolicy: { refundable: true, freeCancellationDays: 3 },
            breakfastIncluded: true,
            availability: { unitsLeft: 5 },
          },
        ],
      },
    ],
    ...overrides,
  }
}

export function searchResult(
  supplier: SupplierCode,
  properties: readonly SupplierProperty[],
): SupplierSearchResult {
  return {
    supplier,
    checkIn: '2026-11-10',
    checkOut: '2026-11-12',
    properties: properties.map((item) => ({ ...item, supplier })),
  }
}

/** Skenario satu supplier: menjawab, gagal, atau menggantung sampai dilepas. */
export type SupplierScript =
  | { readonly kind: 'responds'; readonly properties: readonly SupplierProperty[] }
  | { readonly kind: 'fails'; readonly message?: string }
  | { readonly kind: 'hangs' }

export interface FakeSupplierGateway extends SupplierGateway {
  /** Berapa kali setiap supplier benar-benar dipanggil. */
  readonly searched: Map<SupplierCode, number>
  readonly directoryCalls: { count: number }
  /** Melepas supplier yang menggantung, dengan jawabannya. */
  release(supplier: SupplierCode, properties: readonly SupplierProperty[]): void
  releaseError(supplier: SupplierCode, message?: string): void
}

export function fakeSuppliers(
  scripts: Readonly<Partial<Record<SupplierCode, SupplierScript>>>,
  statuses?: readonly SupplierStatus[],
): FakeSupplierGateway {
  const searched = new Map<SupplierCode, number>()
  const directoryCalls = { count: 0 }
  const hanging = new Map<
    SupplierCode,
    { resolve: (value: SupplierSearchResult) => void; reject: (error: unknown) => void }
  >()

  const directory: readonly SupplierStatus[] =
    statuses ??
    (Object.keys(scripts) as SupplierCode[]).map((supplier) => ({
      supplier,
      isActive: true,
      circuit: 'closed' as const,
    }))

  return {
    searched,
    directoryCalls,

    async directory() {
      directoryCalls.count += 1
      return await Promise.resolve(directory)
    },

    async search(supplier) {
      searched.set(supplier, (searched.get(supplier) ?? 0) + 1)
      const script = scripts[supplier] ?? { kind: 'responds' as const, properties: [] }

      if (script.kind === 'fails') {
        await Promise.resolve()
        throw new Error(script.message ?? 'supplier tumbang')
      }

      if (script.kind === 'hangs') {
        return await new Promise<SupplierSearchResult>((resolve, reject) => {
          hanging.set(supplier, { resolve, reject })
        })
      }

      return await Promise.resolve(searchResult(supplier, script.properties))
    },

    release(supplier, properties) {
      hanging.get(supplier)?.resolve(searchResult(supplier, properties))
    },

    releaseError(supplier, message = 'supplier tumbang') {
      hanging.get(supplier)?.reject(new Error(message))
    },
  }
}

/**
 * Markup 20% lalu PPN 11%, dihitung tangan supaya nilainya dapat diperiksa.
 *
 * Rp 1.000.000 × 1,2 = Rp 1.200.000 ; × 1,11 = Rp 1.332.000
 */
export const MARKUP_BP = 2_000
export const TAX_BP = 1_100

export interface FakePricingGateway extends PricingGateway {
  /** Berapa kali pricing-service dipanggil. Harus satu per pencarian. */
  readonly calls: { count: number; items: number[] }
  failNext(): void
  dropRef(ref: string): void
}

export function fakePricing(): FakePricingGateway {
  const calls = { count: 0, items: [] as number[] }
  const dropped = new Set<string>()
  let fail = false

  return {
    calls,

    failNext() {
      fail = true
    },

    dropRef(ref) {
      dropped.add(ref)
    },

    async price(items: readonly PricingRequestItem[]): Promise<readonly PricedItem[]> {
      calls.count += 1
      calls.items.push(items.length)

      if (fail) {
        fail = false
        await Promise.resolve()
        throw new Error('pricing-service tumbang')
      }

      return await Promise.resolve(
        items
          .filter((item) => !dropped.has(item.ref))
          .map((item) => {
            const base = item.supplierTotal.amountMinor
            const markup = Math.round((base * MARKUP_BP) / 10_000)
            const total = Math.round(((base + markup) * (10_000 + TAX_BP)) / 10_000)

            return {
              ref: item.ref,
              base: money(base, 'IDR'),
              markup: money(markup, 'IDR'),
              tax: money(total - base - markup, 'IDR'),
              total: money(total, 'IDR'),
              taxName: 'PPN',
            }
          }),
      )
    },
  }
}

export interface FakeResultCache extends ResultCache {
  readonly entries: Map<string, CachedResultBody>
  readonly calls: { reads: number; writes: number }
  failNextWrite(): void
  age(key: string, ms: number): void
}

export function fakeResultCache(): FakeResultCache {
  const entries = new Map<string, CachedResultBody>()
  const tags = new Map<string, Set<string>>()
  const ages = new Map<string, number>()
  const calls = { reads: 0, writes: 0 }
  let failWrite = false

  return {
    entries,
    calls,

    failNextWrite() {
      failWrite = true
    },

    age(key, ms) {
      ages.set(key, ms)
    },

    async read(key): Promise<CachedResult | undefined> {
      calls.reads += 1
      const body = entries.get(key)

      return await Promise.resolve(
        body === undefined ? undefined : { ...body, ageMs: ages.get(key) ?? 0 },
      )
    },

    async write(key, value, cityTag) {
      calls.writes += 1
      if (failWrite) {
        failWrite = false
        await Promise.resolve()
        throw new Error('redis tumbang')
      }

      entries.set(key, value)
      const tagged = tags.get(cityTag) ?? new Set<string>()
      tagged.add(key)
      tags.set(cityTag, tagged)

      await Promise.resolve()
    },

    async invalidateCity(cityTag) {
      const tagged = tags.get(cityTag) ?? new Set<string>()
      for (const key of tagged) entries.delete(key)
      tags.delete(cityTag)

      return await Promise.resolve(tagged.size)
    },
  }
}

export interface FakeSupplierCache extends SupplierResultCache {
  readonly entries: Map<string, SupplierSearchResult>
  readonly calls: { reads: number; writes: number }
}

export function fakeSupplierCache(): FakeSupplierCache {
  const entries = new Map<string, SupplierSearchResult>()
  const calls = { reads: 0, writes: 0 }

  return {
    entries,
    calls,

    async read(key) {
      calls.reads += 1
      return await Promise.resolve(entries.get(key))
    },

    async write(key, result) {
      calls.writes += 1
      entries.set(key, result)
      await Promise.resolve()
    },
  }
}

/**
 * Single-flight sungguhan, bukan tiruan.
 *
 * Diuji bersama sisanya karena inilah yang mencegah cache stampede — dan
 * tiruan yang selalu menjalankan pekerjaannya tidak membuktikan apa pun
 * tentang pencegahan itu.
 */
export function inMemorySingleFlight(): SingleFlight {
  const running = new Map<string, Promise<unknown>>()

  return {
    async run<T>(key: string, work: () => Promise<T>): Promise<T> {
      const existing = running.get(key)
      if (existing !== undefined) return (await existing) as T

      const promise = work().finally(() => {
        running.delete(key)
      })
      running.set(key, promise)

      return await promise
    },
  }
}

export interface FakeEvents extends SearchEvents {
  readonly published: SearchPerformedPayload[]
}

export function fakeEvents(): FakeEvents {
  const published: SearchPerformedPayload[] = []

  return {
    published,
    async performed(payload) {
      published.push(payload)
      await Promise.resolve()
    },
  }
}

export interface FakeMetrics extends SearchMetrics {
  readonly hits: Record<string, number>
  readonly misses: Record<string, number>
}

export function fakeMetrics(): FakeMetrics {
  const hits: Record<string, number> = {}
  const misses: Record<string, number> = {}

  return {
    hits,
    misses,
    cacheHit: (layer) => {
      hits[layer] = (hits[layer] ?? 0) + 1
    },
    cacheMiss: (layer) => {
      misses[layer] = (misses[layer] ?? 0) + 1
    },
  }
}

/** Anggaran waktu yang dihabiskan tangan. */
export interface ManualDeadline {
  factory: (budgetMs: number) => Deadline
  expire(): void
}

export function manualDeadline(): ManualDeadline {
  let release = (): void => undefined
  const expired = new Promise<void>((resolve) => {
    release = resolve
  })

  return {
    factory: () => ({ expired, cancel: () => undefined }),
    expire: () => {
      release()
    },
  }
}

export interface SearchHarness {
  readonly deps: SearchDeps
  readonly suppliers: FakeSupplierGateway
  readonly pricing: FakePricingGateway
  readonly results: FakeResultCache
  readonly supplierResults: FakeSupplierCache
  readonly events: FakeEvents
  readonly metrics: FakeMetrics
  readonly clock: { value: number }
}

export function searchHarness(
  options: {
    readonly scripts?: Readonly<Partial<Record<SupplierCode, SupplierScript>>>
    readonly statuses?: readonly SupplierStatus[]
    readonly budgetMs?: number
    readonly withoutCatalog?: boolean
  } = {},
): SearchHarness {
  const suppliers = fakeSuppliers(
    options.scripts ?? { SKY: { kind: 'responds', properties: [supplierProperty('sky-padma')] } },
    options.statuses,
  )
  const pricing = fakePricing()
  const results = fakeResultCache()
  const supplierResults = fakeSupplierCache()
  const events = fakeEvents()
  const metrics = fakeMetrics()
  const clock = { value: 1_000 }

  return {
    suppliers,
    pricing,
    results,
    supplierResults,
    events,
    metrics,
    clock,
    deps: {
      catalog: () => (options.withoutCatalog === true ? undefined : CATALOG),
      suppliers,
      pricing,
      results,
      supplierResults,
      singleFlight: inMemorySingleFlight(),
      events,
      metrics,
      clock: { now: () => clock.value },
      settings: { budgetMs: options.budgetMs ?? 1_200, today: () => '2026-09-24' },
    },
  }
}
