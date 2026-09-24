import type { Redis } from 'ioredis'
import { buildMappingTable, mappingKey } from '../domain/mapping.js'
import type { Property } from '../domain/property.js'
import type { CatalogContents, CatalogSnapshot, SnapshotStore } from '../application/ports.js'

/**
 * Katalog di Redis.
 *
 * Tiga lapis, dan pembagiannya disengaja:
 *
 *   Postgres → sumber kebenaran, disentuh hanya saat memuat ulang
 *   Redis    → salinan bersama antar instance, ditulis satu kali per muat
 *   Memori   → yang benar-benar dibaca jalur pencarian
 *
 * Lapis ketiga itu yang sering terlewat. Pencarian memanggil pemetaan ratusan
 * kali per permintaan; kalau setiap panggilan menembak Redis, yang dihemat
 * hanyalah beban Postgres, sementara perjalanan jaringannya tetap ratusan
 * kali. Karena itu [CatalogSnapshot] SINKRON — bentuk tipenya sendiri yang
 * menutup kemungkinan memanggil apa pun lewat jaringan dari dalamnya.
 *
 * Redis tetap dibutuhkan meski snapshot hidup di memori: ia membuat sepuluh
 * instance memuat katalog dari Postgres sekali, bukan sepuluh kali, dan ia
 * membawa nomor versi yang memberi tahu setiap instance bahwa ada yang berubah.
 */

const CATALOG_KEY = 'search:catalog'
const VERSION_KEY = 'search:catalog:version'

interface StoredCatalog {
  readonly version: string
  readonly properties: readonly Property[]
  readonly mappings: readonly { s: string; r: string; p: string }[]
}

export interface RedisCatalogOptions {
  readonly ttlSeconds: number
  readonly onCacheError: (error: unknown) => void
}

export function createRedisSnapshotStore(
  redis: Redis,
  options: RedisCatalogOptions,
): SnapshotStore {
  return {
    async read(): Promise<CatalogSnapshot | undefined> {
      const raw = await readRaw(redis, options.onCacheError)
      if (raw === undefined) return undefined

      return toSnapshot({
        properties: raw.properties,
        mappings: raw.mappings.map((item) => ({
          supplierId: item.s,
          supplierPropertyId: item.r,
          propertyId: item.p,
          confidence: 10_000,
          mappedBy: 'cache',
        })),
      })
    },

    async write(contents: CatalogContents): Promise<void> {
      // Pemetaan disimpan dengan nama bidang sependek mungkin. Pada ratusan
      // ribu baris pemetaan, `supplierPropertyId` yang diulang di setiap entri
      // adalah puluhan megabyte yang tidak membawa satu pun informasi.
      const stored: StoredCatalog = {
        version: String(Date.now()),
        properties: contents.properties,
        mappings: contents.mappings.map((item) => ({
          s: item.supplierId,
          r: item.supplierPropertyId,
          p: item.propertyId,
        })),
      }

      try {
        await redis
          .multi()
          .set(CATALOG_KEY, JSON.stringify(stored), 'EX', options.ttlSeconds)
          .set(VERSION_KEY, stored.version, 'EX', options.ttlSeconds)
          .exec()
      } catch (error) {
        options.onCacheError(error)
      }
    },
  }
}

async function readRaw(
  redis: Redis,
  onCacheError: (error: unknown) => void,
): Promise<StoredCatalog | undefined> {
  try {
    const raw = await redis.get(CATALOG_KEY)
    if (raw === null) return undefined

    return JSON.parse(raw) as StoredCatalog
  } catch (error) {
    // Redis yang tumbang TIDAK menggagalkan pemuatan katalog: pemanggil jatuh
    // kembali ke Postgres. Katalog yang tidak termuat berarti setiap properti
    // tampil sebagai belum terpetakan, dan itu jauh lebih merugikan daripada
    // satu pemuatan yang lebih lambat.
    onCacheError(error)
    return undefined
  }
}

/**
 * Versi katalog yang sedang berlaku di Redis.
 *
 * Instance membandingkannya dengan versi yang dipegangnya sendiri untuk tahu
 * apakah perlu memuat ulang. Membandingkan satu string jauh lebih murah
 * daripada menarik seluruh katalog pada setiap denyut penyegaran.
 */
export async function catalogVersion(redis: Redis): Promise<string | undefined> {
  const version = await redis.get(VERSION_KEY)
  return version ?? undefined
}

/**
 * Membatalkan katalog yang tersimpan.
 *
 * Dipanggil setelah operator mengubah pemetaan. Tanpa ini, pemetaan manual
 * baru berlaku setelah TTL habis — dan operator yang memetakan satu properti
 * lalu tidak melihat perubahannya akan memetakannya lagi.
 */
export async function invalidateCatalog(redis: Redis): Promise<void> {
  await redis.del(CATALOG_KEY, VERSION_KEY)
}

/**
 * Snapshot dalam memori.
 *
 * Diekspor supaya penyimpanan uji membangunnya dengan fungsi yang SAMA. Kalau
 * masing-masing membangun tabelnya sendiri, pengujian akan membuktikan
 * perilaku yang tidak pernah benar-benar berjalan.
 */
export function toSnapshot(contents: CatalogContents): CatalogSnapshot {
  const table = buildMappingTable(contents.mappings)
  const byId = new Map(contents.properties.map((item) => [item.id, item]))
  const bySlug = new Map(contents.properties.map((item) => [item.slug, item]))

  return {
    propertyId: (supplierId, supplierPropertyId) =>
      table.get(mappingKey(supplierId, supplierPropertyId)),
    property: (id) => byId.get(id),
    propertyBySlug: (slug) => bySlug.get(slug),
    slugs: () => new Set(bySlug.keys()),
  }
}
