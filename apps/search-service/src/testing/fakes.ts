import { type PropertyMapping } from '../domain/mapping.js'
import { normalizeName } from '../domain/slug.js'
import { toSnapshot } from '../infrastructure/redis-catalog.js'
import type { Property, UnmappedProperty } from '../domain/property.js'
import type {
  CatalogContents,
  CatalogDeps,
  CatalogSource,
  MappingStore,
  PropertyStore,
  SnapshotStore,
  SuggestionCache,
  UnmappedQueue,
  UnmappedSighting,
} from '../application/ports.js'

/**
 * Perkakas uji.
 *
 * Setiap penyimpanan yang mewakili BASIS DATA menghitung berapa kali ia
 * dibaca dan ditulis. Itu bukan kenyamanan: syarat "pemetaan dibaca dari
 * Redis, bukan basis data, pada jalur pencarian" hanya dapat dibuktikan
 * dengan menghitung — mengukur waktu akan lulus pada mesin cepat meski setiap
 * pemetaan menembak Postgres.
 */

export interface Counter {
  reads: number
  writes: number
}

function counter(): Counter {
  return { reads: 0, writes: 0 }
}

export function property(overrides: Partial<Property> = {}): Property {
  const name = overrides.name ?? 'Padma Bali Boutique Hotel'

  return {
    id: 'prop-1',
    slug: 'padma-bali-boutique-hotel',
    name,
    normalizedName: normalizeName(name),
    address: 'Jalan Melati No. 12',
    city: 'Bali',
    countryCode: 'ID',
    latitude: -8.65,
    longitude: 115.216,
    timezone: 'Asia/Makassar',
    starRating: 4,
    amenities: ['pool', 'wifi'],
    photos: [],
    ...overrides,
  }
}

export function mapping(overrides: Partial<PropertyMapping> = {}): PropertyMapping {
  return {
    supplierId: 'SKY',
    supplierPropertyId: 'sky-120804930',
    propertyId: 'prop-1',
    confidence: 10_000,
    mappedBy: 'seed',
    ...overrides,
  }
}

/**
 * Snapshot dalam memori, berdiri untuk Redis.
 *
 * Memakai [toSnapshot] yang SAMA dengan implementasi Redis, bukan salinannya.
 * Penyimpanan uji yang membangun tabelnya sendiri akan membuktikan perilaku
 * yang tidak pernah benar-benar berjalan — dan perbedaannya selalu muncul di
 * tempat yang tidak diduga.
 */
export const snapshotOf = toSnapshot

export interface CountingSnapshotStore extends SnapshotStore {
  readonly calls: Counter
}

export function countingSnapshots(initial?: CatalogContents): CountingSnapshotStore {
  const calls = counter()
  let current = initial

  return {
    calls,
    async read() {
      calls.reads += 1
      return await Promise.resolve(current === undefined ? undefined : snapshotOf(current))
    },
    async write(contents) {
      calls.writes += 1
      current = contents
      await Promise.resolve()
    },
  }
}

export interface CountingPropertyStore extends PropertyStore {
  readonly calls: Counter
  readonly rows: Property[]
}

export function countingProperties(initial: readonly Property[] = []): CountingPropertyStore {
  const calls = counter()
  const rows = [...initial]

  return {
    calls,
    rows,

    async bySlug(slug) {
      calls.reads += 1
      return await Promise.resolve(rows.find((row) => row.slug === slug))
    },

    async byId(id) {
      calls.reads += 1
      return await Promise.resolve(rows.find((row) => row.id === id))
    },

    async upsertMany(properties) {
      calls.writes += 1
      for (const item of properties) {
        const index = rows.findIndex((row) => row.id === item.id)
        if (index === -1) rows.push(item)
        else rows[index] = item
      }
      await Promise.resolve()
    },

    async existingBySource() {
      calls.reads += 1
      return await Promise.resolve(new Map())
    },

    async search(query, limit) {
      calls.reads += 1

      // Berdiri untuk full-text PostgreSQL: cocok bila nama atau kotanya
      // memuat kuerinya. Bentuk hasilnya yang diuji di sini, bukan kualitas
      // peringkatnya — peringkat Postgres diuji pada Step 20.
      const matched = rows.filter(
        (row) => row.normalizedName.includes(query) || normalizeName(row.city).includes(query),
      )

      return await Promise.resolve(matched.slice(0, limit))
    },
  }
}

export interface CountingMappingStore extends MappingStore {
  readonly calls: Counter
  readonly rows: PropertyMapping[]
}

export function countingMappings(initial: readonly PropertyMapping[] = []): CountingMappingStore {
  const calls = counter()
  const rows = [...initial]

  function put(item: PropertyMapping): void {
    const index = rows.findIndex(
      (row) =>
        row.supplierId === item.supplierId && row.supplierPropertyId === item.supplierPropertyId,
    )
    if (index === -1) rows.push(item)
    else rows[index] = item
  }

  return {
    calls,
    rows,

    async all() {
      calls.reads += 1
      return await Promise.resolve([...rows])
    },

    async upsertMany(mappings) {
      calls.writes += 1
      for (const item of mappings) put(item)
      await Promise.resolve()
    },

    async put(item) {
      calls.writes += 1
      put(item)
      await Promise.resolve()
    },
  }
}

export interface CountingUnmappedQueue extends UnmappedQueue {
  readonly calls: Counter
  readonly rows: Map<string, UnmappedProperty>
  failNextWrite(): void
}

const FAKE_NOW = '2026-09-24T00:00:00.000Z'

function mergeSighting(
  existing: UnmappedProperty | undefined,
  entry: UnmappedSighting,
): UnmappedProperty {
  return {
    supplierId: entry.supplierId,
    supplierPropertyId: entry.supplierPropertyId,
    rawName: entry.rawName,
    ...(entry.rawAddress === undefined ? {} : { rawAddress: entry.rawAddress }),
    ...(entry.rawCity === undefined ? {} : { rawCity: entry.rawCity }),
    ...(entry.latitude === undefined ? {} : { latitude: entry.latitude }),
    ...(entry.longitude === undefined ? {} : { longitude: entry.longitude }),
    occurrences: (existing?.occurrences ?? 0) + entry.occurrences,
    firstSeenAt: existing?.firstSeenAt ?? FAKE_NOW,
    lastSeenAt: FAKE_NOW,
  }
}

export function countingUnmapped(initial: readonly UnmappedProperty[] = []): CountingUnmappedQueue {
  const calls = counter()
  const rows = new Map(initial.map((row) => [`${row.supplierId}:${row.supplierPropertyId}`, row]))
  let failWrite = false

  return {
    calls,
    rows,

    failNextWrite() {
      failWrite = true
    },

    async recordSeen(entries: readonly UnmappedSighting[]) {
      calls.writes += 1
      if (failWrite) {
        failWrite = false
        throw new Error('basis data sedang tumbang')
      }

      for (const entry of entries) {
        const key = `${entry.supplierId}:${entry.supplierPropertyId}`
        rows.set(key, mergeSighting(rows.get(key), entry))
      }

      await Promise.resolve()
    },

    async pending(limit) {
      calls.reads += 1
      return await Promise.resolve(
        [...rows.values()].sort((a, b) => b.occurrences - a.occurrences).slice(0, limit),
      )
    },

    async find(supplierId, supplierPropertyId) {
      calls.reads += 1
      return await Promise.resolve(rows.get(`${supplierId}:${supplierPropertyId}`))
    },

    async resolve(supplierId, supplierPropertyId) {
      calls.writes += 1
      return await Promise.resolve(rows.delete(`${supplierId}:${supplierPropertyId}`))
    },
  }
}

export interface CountingSuggestionCache extends SuggestionCache {
  readonly calls: Counter
}

export function countingSuggestions(): CountingSuggestionCache {
  const calls = counter()
  const entries = new Map<string, readonly Property[]>()

  return {
    calls,
    async read(key) {
      calls.reads += 1
      return await Promise.resolve(entries.get(key))
    },
    async write(key, properties) {
      calls.writes += 1
      entries.set(key, properties)
      await Promise.resolve()
    },
  }
}

export function sourceOf(contents: CatalogContents): CatalogSource {
  return { load: async () => await Promise.resolve(contents) }
}

export interface Harness {
  readonly deps: CatalogDeps
  readonly snapshots: CountingSnapshotStore
  readonly properties: CountingPropertyStore
  readonly mappings: CountingMappingStore
  readonly unmapped: CountingUnmappedQueue
  readonly suggestions: CountingSuggestionCache
}

export function harness(
  options: {
    readonly properties?: readonly Property[]
    readonly mappings?: readonly PropertyMapping[]
    readonly unmapped?: readonly UnmappedProperty[]
    /** Kosongkan snapshot untuk menguji keadaan belum siap. */
    readonly withoutSnapshot?: boolean
  } = {},
): Harness {
  const rows = options.properties ?? [property()]
  const links = options.mappings ?? [mapping()]

  const snapshots = countingSnapshots(
    options.withoutSnapshot === true ? undefined : { properties: rows, mappings: links },
  )
  const properties = countingProperties(rows)
  const mappings = countingMappings(links)
  const unmapped = countingUnmapped(options.unmapped ?? [])
  const suggestions = countingSuggestions()

  return {
    snapshots,
    properties,
    mappings,
    unmapped,
    suggestions,
    deps: { snapshots, properties, mappings, unmapped, suggestions },
  }
}
