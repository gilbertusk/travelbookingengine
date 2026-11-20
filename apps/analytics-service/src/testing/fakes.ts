import { createLogger, type Logger } from '@tbe/shared-kernel'
import type {
  AnalyticsDeps,
  AnalyticsStore,
  ConsumerOffsets,
  DayRange,
  RecordUnit,
  RewindCheck,
} from '../application/ports.js'
import { METRICS, mergeIncrements } from '../domain/counters.js'
import type { SupplierCode } from '../domain/facts.js'
import type { CounterRow } from '../domain/summary.js'

/**
 * Penyimpan dalam memori yang MENIRU dua sifat Postgres yang diandalkan
 * analitik: pesan yang sama tidak pernah dihitung dua kali (kunci primer
 * event_id), dan reset mengosongkan ketiga tabel bersamaan. Penambahan
 * atomik antar-instance TIDAK ditiru — itu dibuktikan di tests/integration.
 */
export interface MemoryStore extends AnalyticsStore {
  readonly rows: () => ReadonlyMap<string, number>
  readonly processed: () => ReadonlySet<string>
  failNextRecord(): void
}

interface MemoryTables {
  readonly counters: ReadonlyMap<string, number>
  readonly processed: ReadonlySet<string>
  readonly suppliers: ReadonlyMap<string, SupplierCode>
}

const EMPTY: MemoryTables = { counters: new Map(), processed: new Set(), suppliers: new Map() }

/** Satu pencatatan atas salinan tabel — tabel lama tidak pernah diubah di tempat. */
function applied(tables: MemoryTables, unit: RecordUnit): MemoryTables {
  const counters = new Map(tables.counters)
  for (const increment of mergeIncrements(unit.increments)) {
    const key = [increment.day, increment.metric, increment.dimension].join('\u0000')
    counters.set(key, (counters.get(key) ?? 0) + increment.by)
  }
  const mapping = unit.bookingSupplier
  const suppliers =
    mapping === undefined || tables.suppliers.has(mapping.bookingId)
      ? tables.suppliers
      : new Map([...tables.suppliers, [mapping.bookingId, mapping.supplier]])

  return { counters, processed: new Set([...tables.processed, unit.eventId]), suppliers }
}

function rowsIn(tables: MemoryTables, range: DayRange): CounterRow[] {
  return [...tables.counters.entries()].flatMap(([key, value]): CounterRow[] => {
    const [day = '', name = '', dimension = ''] = key.split('\u0000')
    const metric = METRICS.find((candidate) => candidate === name)
    return metric !== undefined && day >= range.from && day <= range.to
      ? [{ metric, dimension, value }]
      : []
  })
}

export function memoryStore(): MemoryStore {
  let tables = EMPTY
  let shouldFail = false

  return {
    rows: () => tables.counters,
    processed: () => tables.processed,
    failNextRecord: () => {
      shouldFail = true
    },
    async supplierOf(bookingId) {
      await Promise.resolve()
      return tables.suppliers.get(bookingId)
    },
    async record(unit) {
      await Promise.resolve()
      if (shouldFail) {
        shouldFail = false
        throw new Error('basis data tidak dapat dihubungi')
      }
      if (tables.processed.has(unit.eventId)) return 'duplicate'
      tables = applied(tables, unit)
      return 'recorded'
    },
    async counters(range) {
      await Promise.resolve()
      return rowsIn(tables, range)
    },
    async processedCount() {
      await Promise.resolve()
      return tables.processed.size
    },
    async reset() {
      await Promise.resolve()
      tables = EMPTY
    },
  }
}

export interface RecordingOffsets extends ConsumerOffsets {
  readonly rewound: readonly { readonly groupId: string; readonly topic: string }[]
}

export function recordingOffsets(state: RewindCheck = { kind: 'idle' }): RecordingOffsets {
  const rewound: { groupId: string; topic: string }[] = []
  return {
    rewound,
    async check() {
      return await Promise.resolve(state)
    },
    async rewindToEarliest(groupId, topics) {
      await Promise.resolve()
      rewound.push(...topics.map((topic) => ({ groupId, topic })))
    },
  }
}

export function silentLogger(): Logger {
  return createLogger({ serviceName: 'analytics-test', level: 'silent' })
}

export const NOW = new Date('2026-10-25T09:00:00.000Z')

export function deps(store: AnalyticsStore = memoryStore()): AnalyticsDeps {
  return { store, clock: { now: () => NOW }, logger: silentLogger() }
}
