import type { Redis } from 'ioredis'
import { describe, expect, test } from 'vitest'
import { withRateCache } from './cached-rates.js'
import { createTaxPolicyProvider } from './tax-policies.js'
import { countingRates, PPN, USD_TO_IDR } from '../testing/fakes.js'

/**
 * Cache kurs.
 *
 * Yang diuji di sini bukan Redis-nya, melainkan keputusan di sekitarnya:
 * bahwa Redis yang tumbang TIDAK menggagalkan penetapan harga. Harga yang
 * tidak terhitung karena cache tumbang adalah kerugian yang jauh lebih besar
 * daripada satu pencarian yang sedikit lebih lambat.
 */

interface FakeRedis {
  readonly redis: Redis
  readonly writes: { key: string; value: string; ttl: number }[]
}

function fakeRedis(
  behaviour: {
    readonly stored?: string | null
    readonly failOnGet?: boolean
    readonly failOnSet?: boolean
  } = {},
): FakeRedis {
  const writes: { key: string; value: string; ttl: number }[] = []
  let stored = behaviour.stored ?? null

  const redis = {
    get: async (key: string) => {
      if (behaviour.failOnGet === true) throw new Error(`redis mati saat membaca ${key}`)
      return await Promise.resolve(stored)
    },
    set: async (key: string, value: string, _mode: string, ttl: number) => {
      if (behaviour.failOnSet === true) throw new Error(`redis mati saat menulis ${key}`)
      writes.push({ key, value, ttl })
      stored = value
      return await Promise.resolve('OK')
    },
  }

  return { redis: redis as unknown as Redis, writes }
}

function silent(): { calls: unknown[]; onCacheError: (error: unknown) => void } {
  const calls: unknown[] = []
  return { calls, onCacheError: (error) => calls.push(error) }
}

describe('pembacaan lewat cache', () => {
  test('sumber hanya dibaca sekali ketika cache terisi', async () => {
    const cache = fakeRedis()
    const source = countingRates()
    const errors = silent()
    const cached = withRateCache(source, cache.redis, {
      ttlSeconds: 60,
      onCacheError: errors.onCacheError,
    })

    await cached.current()
    await cached.current()

    expect(source.reads.count).toBe(1)
  })

  test('kurs dari cache sama dengan kurs dari sumber', async () => {
    const cache = fakeRedis()
    const cached = withRateCache(countingRates(), cache.redis, {
      ttlSeconds: 60,
      onCacheError: silent().onCacheError,
    })

    await cached.current()

    expect(await cached.current()).toEqual([USD_TO_IDR])
  })

  test('ditulis dengan masa berlaku, bukan selamanya', async () => {
    // Kurs basi berarti harga jual yang salah, dan harga jual yang salah
    // adalah kerugian — bukan sekadar tampilan yang usang.
    const cache = fakeRedis()
    const cached = withRateCache(countingRates(), cache.redis, {
      ttlSeconds: 45,
      onCacheError: silent().onCacheError,
    })

    await cached.current()

    expect(cache.writes[0]?.ttl).toBe(45)
  })
})

describe('Redis yang tumbang', () => {
  test('kegagalan membaca cache jatuh kembali ke sumber, bukan menggagalkan harga', async () => {
    const cache = fakeRedis({ failOnGet: true })
    const source = countingRates()
    const errors = silent()
    const cached = withRateCache(source, cache.redis, {
      ttlSeconds: 60,
      onCacheError: errors.onCacheError,
    })

    expect(await cached.current()).toEqual([USD_TO_IDR])
    expect(source.reads.count).toBe(1)
  })

  test('kegagalan menulis cache tetap mengembalikan kurs', async () => {
    const cache = fakeRedis({ failOnSet: true })
    const cached = withRateCache(countingRates(), cache.redis, {
      ttlSeconds: 60,
      onCacheError: silent().onCacheError,
    })

    expect(await cached.current()).toEqual([USD_TO_IDR])
  })

  test('kegagalan cache dilaporkan, tidak ditelan diam-diam', async () => {
    // Cache yang gagal terus-menerus tanpa terlihat berarti setiap pencarian
    // menambah satu perjalanan ke basis data tanpa ada yang tahu.
    const errors = silent()
    const cached = withRateCache(countingRates(), fakeRedis({ failOnGet: true }).redis, {
      ttlSeconds: 60,
      onCacheError: errors.onCacheError,
    })

    await cached.current()

    expect(errors.calls).toHaveLength(1)
  })

  test('isi cache yang rusak diperlakukan sebagai cache kosong', async () => {
    // Nilai yang tidak dapat diurai berarti ada yang salah menulisnya. Jatuh
    // kembali ke basis data lebih aman daripada melempar galat pada jalur
    // pencarian.
    const cache = fakeRedis({ stored: 'ini-bukan-json' })
    const source = countingRates()
    const errors = silent()
    const cached = withRateCache(source, cache.redis, {
      ttlSeconds: 60,
      onCacheError: errors.onCacheError,
    })

    expect(await cached.current()).toEqual([USD_TO_IDR])
    expect(errors.calls).toHaveLength(1)
  })
})

describe('kebijakan pajak', () => {
  test('satu tarif untuk seluruh kota pada MVP', () => {
    // Bentuk antarmukanya per kota karena itulah bentuk yang dibutuhkan
    // begitu ada inventaris di luar negeri; isinya belum membedakan.
    const provider = createTaxPolicyProvider(PPN)

    expect(provider.forCity('Bali')).toEqual(PPN)
    expect(provider.forCity('Lombok')).toEqual(PPN)
  })
})
