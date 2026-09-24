import type { PropertyMapping } from '../domain/mapping.js'
import type { Property, UnmappedProperty } from '../domain/property.js'

/**
 * Port katalog.
 *
 * Pembagiannya mengikuti satu batas yang tidak boleh kabur: apa yang boleh
 * disentuh JALUR PENCARIAN, dan apa yang tidak.
 *
 *   Boleh   : CatalogSnapshot        — dibaca dari Redis
 *   Tidak   : CatalogSource          — basis data
 *
 * Step 13 memberi pencarian anggaran waktu yang ketat, dan pencarian memanggil
 * pemetaan sekali untuk setiap properti yang dikembalikan setiap supplier —
 * ratusan kali per permintaan. Satu perjalanan ke basis data per pemetaan
 * akan menghabiskan anggaran itu sendirian.
 *
 * Katalognya kecil: ratusan properti, data statis, jarang berubah. Seluruhnya
 * muat di Redis, dan karena itu jalur pencarian tidak perlu menyentuh Postgres
 * sama sekali. Pembagian port ini yang membuat aturan tersebut dapat diuji,
 * bukan sekadar diniatkan.
 */

/** Katalog sebagaimana adanya di Redis. Hanya ini yang boleh dibaca pencarian. */
export interface CatalogSnapshot {
  propertyId(supplierId: string, supplierPropertyId: string): string | undefined
  property(propertyId: string): Property | undefined
  propertyBySlug(slug: string): Property | undefined
  /**
   * Seluruh slug yang sudah terpakai.
   *
   * Dipakai saat operator membuat properti baru, untuk menjamin slug barunya
   * unik. Diambil dari snapshot karena seluruh katalog sudah ada di memori;
   * satu kueri lagi untuk hal yang sudah di tangan adalah kueri yang tidak
   * perlu.
   */
  slugs(): ReadonlySet<string>
}

export interface SnapshotStore {
  read(): Promise<CatalogSnapshot | undefined>
  write(catalog: CatalogContents): Promise<void>
}

export interface CatalogContents {
  readonly properties: readonly Property[]
  readonly mappings: readonly PropertyMapping[]
}

/**
 * Sumber katalog: basis data.
 *
 * Dipanggil saat startup dan pada penyegaran berkala — TIDAK pada jalur
 * pencarian. Penyegaran berkala, bukan pembatalan saat berubah, karena
 * katalog berubah beberapa kali sehari dan data statis yang basi beberapa
 * puluh detik tidak merugikan siapa pun. Yang tidak boleh basi adalah harga,
 * dan harga tidak pernah masuk ke sini.
 */
export interface CatalogSource {
  load(): Promise<CatalogContents>
}

export interface PropertyStore {
  bySlug(slug: string): Promise<Property | undefined>
  byId(id: string): Promise<Property | undefined>
  upsertMany(properties: readonly Property[]): Promise<void>
  /** Properti yang sudah ada, menurut pengenal sumber seed. */
  existingBySource(supplierId: string): Promise<ReadonlyMap<string, { id: string; slug: string }>>
  /** Autocomplete. Memakai full-text PostgreSQL — lihat infrastructure. */
  search(query: string, limit: number): Promise<readonly Property[]>
}

export interface MappingStore {
  all(): Promise<readonly PropertyMapping[]>
  upsertMany(mappings: readonly PropertyMapping[]): Promise<void>
  put(mapping: PropertyMapping): Promise<void>
}

export interface UnmappedQueue {
  /** Menaikkan penghitung kemunculan, atau membuat barisnya bila baru. */
  recordSeen(entries: readonly UnmappedSighting[]): Promise<void>
  pending(limit: number): Promise<readonly UnmappedProperty[]>
  find(supplierId: string, supplierPropertyId: string): Promise<UnmappedProperty | undefined>
  resolve(supplierId: string, supplierPropertyId: string): Promise<boolean>
}

export interface UnmappedSighting {
  readonly supplierId: string
  readonly supplierPropertyId: string
  readonly rawName: string
  readonly rawAddress?: string | undefined
  readonly rawCity?: string | undefined
  readonly latitude?: number | undefined
  readonly longitude?: number | undefined
  readonly occurrences: number
}

/** Cache hasil autocomplete. Kuerinya berulang; jawabannya jarang berubah. */
export interface SuggestionCache {
  read(key: string): Promise<readonly Property[] | undefined>
  write(key: string, properties: readonly Property[]): Promise<void>
}

export interface CatalogDeps {
  readonly snapshots: SnapshotStore
  readonly properties: PropertyStore
  readonly mappings: MappingStore
  readonly unmapped: UnmappedQueue
  readonly suggestions: SuggestionCache
}
