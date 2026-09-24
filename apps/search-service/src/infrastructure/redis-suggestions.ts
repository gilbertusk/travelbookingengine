import type { Redis } from 'ioredis'
import type { Property } from '../domain/property.js'
import type { SuggestionCache } from '../application/ports.js'

/**
 * Cache saran autocomplete.
 *
 * Kotak pencarian menghasilkan kueri yang sangat berulang: ribuan pengguna
 * mengetik awalan nama kota yang sama. TTL-nya boleh panjang — katalog adalah
 * data statis, dan saran yang terlambat beberapa menit mengikuti properti baru
 * tidak merugikan siapa pun.
 *
 * Kegagalan Redis TIDAK menggagalkan saran: ia jatuh kembali ke basis data.
 * Kotak pencarian yang berhenti memberi saran terlihat rusak bagi pengguna,
 * dan katalognya cukup kecil untuk dilayani Postgres langsung.
 */

const PREFIX = 'search:suggest:'

export interface SuggestionCacheOptions {
  readonly ttlSeconds: number
  readonly onCacheError: (error: unknown) => void
}

export function createRedisSuggestionCache(
  redis: Redis,
  options: SuggestionCacheOptions,
): SuggestionCache {
  return {
    async read(key: string): Promise<readonly Property[] | undefined> {
      try {
        const raw = await redis.get(PREFIX + key)
        if (raw === null) return undefined

        return JSON.parse(raw) as readonly Property[]
      } catch (error) {
        options.onCacheError(error)
        return undefined
      }
    },

    async write(key: string, properties: readonly Property[]): Promise<void> {
      try {
        await redis.set(PREFIX + key, JSON.stringify(properties), 'EX', options.ttlSeconds)
      } catch (error) {
        options.onCacheError(error)
      }
    },
  }
}

/**
 * Membuang seluruh saran yang tersimpan.
 *
 * Dipanggil setelah katalog berubah — properti baru yang tidak pernah muncul
 * di saran adalah properti yang tidak pernah ditemukan pengguna.
 *
 * Memakai SCAN, bukan KEYS. `KEYS` memblokir seluruh Redis selama pemindaian,
 * dan Redis yang sama juga memegang hold pemesanan pada Step 17.
 */
export async function invalidateSuggestions(redis: Redis): Promise<number> {
  let cursor = '0'
  let removed = 0

  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${PREFIX}*`, 'COUNT', 200)
    cursor = next

    if (keys.length > 0) {
      await redis.del(...keys)
      removed += keys.length
    }
  } while (cursor !== '0')

  return removed
}
