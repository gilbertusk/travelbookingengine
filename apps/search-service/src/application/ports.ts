import type { Money } from '@tbe/money'
import type { SupplierCode, SupplierSearchResult } from '@tbe/supplier-adapters'
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

/* ------------------------------------------------------------------------ *
 * Pencarian (Step 13)
 * ------------------------------------------------------------------------ */

/**
 * Pintu ke supplier-service.
 *
 * Seluruh ketahanan — pemutus sirkuit, percobaan ulang, pembatasan laju —
 * hidup di sana, bukan di sini. Yang dibutuhkan pencarian hanyalah memanggil
 * dan tahu siapa yang sedang tidak dapat dipanggil.
 */
export interface SupplierGateway {
  search(supplier: SupplierCode, criteria: SupplierSearchCriteria): Promise<SupplierSearchResult>
  /** Keadaan seluruh supplier. Dibaca berkala, bukan pada setiap pencarian. */
  directory(): Promise<readonly SupplierStatus[]>
}

export interface SupplierSearchCriteria {
  readonly city: string
  readonly checkIn: string
  readonly checkOut: string
  readonly guests: number
}

export interface SupplierStatus {
  readonly supplier: SupplierCode
  readonly isActive: boolean
  /** `open` berarti supplier dilewati tanpa dipanggil sama sekali. */
  readonly circuit: 'closed' | 'half_open' | 'open'
}

/**
 * Pintu ke pricing-service.
 *
 * Menerima SELURUH tawaran dalam satu panggilan. Bentuk port-nya yang
 * menjaganya: tidak ada metode yang menerima satu tawaran, jadi tidak ada
 * cara memanggilnya per rate plan bahkan kalau seseorang ingin.
 */
export interface PricingGateway {
  price(items: readonly PricingRequestItem[]): Promise<readonly PricedItem[]>
}

export interface PricingRequestItem {
  readonly ref: string
  readonly supplier: SupplierCode
  readonly city: string
  readonly supplierTotal: Money
}

export interface PricedItem {
  readonly ref: string
  readonly total: Money
  readonly base: Money
  readonly markup: Money
  readonly tax: Money
  readonly taxName: string
}

/** Cache lapis pertama: hasil gabungan yang sudah berharga. */
export interface ResultCache {
  read(key: string): Promise<CachedResult | undefined>
  write(key: string, value: CachedResultBody, cityTag: string): Promise<void>
  /** Membuang seluruh hasil satu kota. Untuk keperluan operasi. */
  invalidateCity(cityTag: string): Promise<number>
}

export interface CachedResultBody {
  readonly payload: unknown
  readonly suppliers: readonly SupplierCode[]
  readonly storedAtMs: number
}

export interface CachedResult extends CachedResultBody {
  readonly ageMs: number
}

/**
 * Cache lapis kedua: jawaban mentah satu supplier.
 *
 * Inilah yang membuat jawaban supplier lambat tetap berguna, dan yang membuat
 * pemulihan satu supplier tidak membatalkan seluruh cache.
 */
export interface SupplierResultCache {
  read(key: string): Promise<SupplierSearchResult | undefined>
  write(key: string, result: SupplierSearchResult): Promise<void>
}

/**
 * Penguncian singkat per kunci, pencegah cache stampede.
 *
 * Tanpa ini, seratus permintaan yang tiba bersamaan untuk kunci yang sama
 * memicu seratus fan-out ke lima supplier — lima ratus panggilan untuk satu
 * jawaban. Justru pada saat trafik paling tinggi, yaitu saat supplier paling
 * tidak mampu menerimanya.
 */
export interface SingleFlight {
  /**
   * Menjalankan `work` sekali untuk `key`. Pemanggil lain menunggu hasil yang
   * sama alih-alih menjalankan pekerjaannya sendiri.
   */
  run<T>(key: string, work: () => Promise<T>): Promise<T>
}

export interface SearchEvents {
  performed(payload: SearchPerformedPayload): Promise<void>
}

export interface SearchPerformedPayload {
  readonly city: string
  readonly checkIn: string
  readonly checkOut: string
  readonly guests: number
  readonly resultCount: number
  readonly latencyMs: number
  readonly source: 'cache' | 'live' | 'partial_cache'
  readonly suppliersResponded: readonly SupplierCode[]
  readonly suppliersTimedOut: readonly SupplierCode[]
  readonly suppliersUnavailable: readonly SupplierCode[]
}

/** Metrik cache per lapisan. Dicatat di sini supaya jalur pencarian tidak tahu prom-client. */
export interface SearchMetrics {
  cacheHit(layer: 'results' | 'supplier'): void
  cacheMiss(layer: 'results' | 'supplier'): void
}

export interface Clock {
  now(): number
}

export interface SearchDeps {
  readonly catalog: () => CatalogSnapshot | undefined
  readonly suppliers: SupplierGateway
  readonly pricing: PricingGateway
  readonly results: ResultCache
  readonly supplierResults: SupplierResultCache
  readonly singleFlight: SingleFlight
  readonly events: SearchEvents
  readonly metrics: SearchMetrics
  readonly clock: Clock
  readonly settings: SearchSettings
}

export interface SearchSettings {
  /** Anggaran waktu total fan-out. Mulai dari 1200ms. */
  readonly budgetMs: number
  readonly today: () => string
}
