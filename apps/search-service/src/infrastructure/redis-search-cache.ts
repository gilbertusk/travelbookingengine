import type { Redis } from 'ioredis'
import type { SupplierSearchResult } from '@tbe/supplier-adapters'
import type {
  CachedResult,
  CachedResultBody,
  ResultCache,
  SingleFlight,
  SupplierResultCache,
} from '../application/ports.js'

/**
 * Cache pencarian berlapis.
 *
 * Lapis 1 — hasil gabungan yang sudah berharga jual. TTL pendek.
 * Lapis 2 — jawaban mentah satu supplier. TTL sedikit lebih panjang.
 *
 * Pembagiannya bukan optimasi bertingkat. Lapis kedua punya satu tugas yang
 * tidak dapat dilakukan lapis pertama: memanen jawaban supplier yang datang
 * SETELAH anggaran waktu habis. Tanpa lapis kedua, jawaban itu tidak punya
 * tempat untuk disimpan, dan supplier lambat tidak pernah berkontribusi.
 *
 * Lapis kedua juga yang membuat pemulihan satu supplier tidak membatalkan
 * seluruh cache: yang kedaluwarsa hanya entri supplier itu.
 */

export interface SearchCacheOptions {
  readonly resultTtlSeconds: number
  readonly supplierTtlSeconds: number
  readonly onCacheError: (error: unknown) => void
}

export function createRedisResultCache(redis: Redis, options: SearchCacheOptions): ResultCache {
  return {
    async read(key: string): Promise<CachedResult | undefined> {
      try {
        const raw = await redis.get(key)
        if (raw === null) return undefined

        const body = JSON.parse(raw) as CachedResultBody

        // Umur dihitung dari cap waktu yang ikut tersimpan, bukan dari TTL
        // yang tersisa. TTL menjawab "berapa lama lagi"; yang perlu diketahui
        // klien adalah "sudah berapa lama" — dan keduanya hanya sama bila
        // TTL-nya tidak pernah berubah.
        return { ...body, ageMs: Math.max(Date.now() - body.storedAtMs, 0) }
      } catch (error) {
        // Cache yang tidak terbaca berarti pencarian dihitung ulang. Lebih
        // lambat, tetap benar.
        options.onCacheError(error)
        return undefined
      }
    },

    async write(key: string, value: CachedResultBody, cityTag: string): Promise<void> {
      try {
        // Kunci didaftarkan ke himpunan per kota supaya operator dapat
        // membatalkan seluruh kota tanpa memindai keyspace. SCAN atas jutaan
        // kunci untuk membuang beberapa ratus adalah harga yang tidak perlu
        // dibayar setiap kali aturan markup berubah.
        await redis
          .multi()
          .set(key, JSON.stringify(value), 'EX', options.resultTtlSeconds)
          .sadd(cityTag, key)
          // Penanda kota hidup lebih lama dari entrinya; anggotanya yang sudah
          // kedaluwarsa tidak berbahaya karena penghapusan yang gagal tidak
          // menghapus apa-apa.
          .expire(cityTag, options.resultTtlSeconds * 4)
          .exec()
      } catch (error) {
        options.onCacheError(error)
      }
    },

    async invalidateCity(cityTag: string): Promise<number> {
      const keys = await redis.smembers(cityTag)
      if (keys.length === 0) return 0

      await redis.del(...keys, cityTag)

      return keys.length
    },
  }
}

export function createRedisSupplierCache(
  redis: Redis,
  options: SearchCacheOptions,
): SupplierResultCache {
  return {
    async read(key: string): Promise<SupplierSearchResult | undefined> {
      try {
        const raw = await redis.get(key)
        return raw === null ? undefined : (JSON.parse(raw) as SupplierSearchResult)
      } catch (error) {
        options.onCacheError(error)
        return undefined
      }
    },

    async write(key: string, result: SupplierSearchResult): Promise<void> {
      try {
        await redis.set(key, JSON.stringify(result), 'EX', options.supplierTtlSeconds)
      } catch (error) {
        options.onCacheError(error)
      }
    },
  }
}

/**
 * Penguncian singkat per kunci, pencegah cache stampede.
 *
 * Dua lapis, dan keduanya dibutuhkan:
 *
 * 1. **Dalam proses.** Seratus permintaan yang tiba bersamaan di instance yang
 *    sama digabung menjadi satu tanpa menyentuh jaringan sama sekali. Ini yang
 *    menangani sebagian besar kasus, karena permintaan yang berdesakan biasanya
 *    mendarat di instance yang sama lewat keep-alive.
 *
 * 2. **Di Redis.** Instance yang berbeda tidak saling melihat, jadi sepuluh
 *    instance tetap dapat menjalankan sepuluh fan-out. Kunci di Redis
 *    menguranginya menjadi satu.
 *
 * Yang TIDAK dilakukan: menunggu pemegang kunci selesai lalu membaca hasilnya.
 * Itu mengubah kegagalan pemegang kunci menjadi kegagalan seratus permintaan
 * sekaligus. Yang kalah mengambil kunci menjalankan pekerjaannya sendiri —
 * lebih boros, tetapi tidak pernah menggantung.
 */
export function createRedisSingleFlight(
  redis: Redis,
  options: { readonly lockTtlSeconds: number; readonly onCacheError: (error: unknown) => void },
): SingleFlight {
  const local = new Map<string, Promise<unknown>>()

  return {
    async run<T>(key: string, work: () => Promise<T>): Promise<T> {
      const running = local.get(key)
      if (running !== undefined) return (await running) as T

      const promise = (async () => {
        await acquire(redis, key, options)
        try {
          return await work()
        } finally {
          await release(redis, key, options)
        }
      })().finally(() => {
        local.delete(key)
      })

      local.set(key, promise)

      return await promise
    },
  }
}

async function acquire(
  redis: Redis,
  key: string,
  options: { readonly lockTtlSeconds: number; readonly onCacheError: (error: unknown) => void },
): Promise<void> {
  try {
    // NX: hanya berhasil bila belum ada pemegangnya. TTL-nya wajib — kunci
    // tanpa masa berlaku yang pemegangnya mati akan memblokir kunci itu
    // selamanya, dan yang terblokir adalah kota yang paling banyak dicari.
    await redis.set(`lock:${key}`, '1', 'EX', options.lockTtlSeconds, 'NX')
  } catch (error) {
    // Redis yang tumbang TIDAK menggagalkan pencarian. Yang hilang hanya
    // penggabungan antar instance; penggabungan dalam proses tetap bekerja.
    options.onCacheError(error)
  }
}

async function release(
  redis: Redis,
  key: string,
  options: { readonly onCacheError: (error: unknown) => void },
): Promise<void> {
  try {
    await redis.del(`lock:${key}`)
  } catch (error) {
    options.onCacheError(error)
  }
}
