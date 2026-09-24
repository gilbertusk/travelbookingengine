import type { Redis } from 'ioredis'
import type { ExchangeRate } from '../domain/pricing.js'
import type { RateProvider } from '../application/ports.js'

/**
 * Kurs yang di-cache di Redis.
 *
 * Kurs berubah jarang dan dibaca pada setiap pencarian. Tanpa cache, setiap
 * permintaan pencarian menambah satu perjalanan ke basis data pada jalur yang
 * paling sensitif terhadap waktu.
 *
 * TTL-nya pendek dengan sengaja. Kurs basi berarti harga jual yang salah, dan
 * harga jual yang salah adalah kerugian — bukan sekadar tampilan yang usang.
 *
 * Kegagalan Redis TIDAK menggagalkan penetapan harga: ia jatuh kembali ke
 * basis data. Harga yang tidak terhitung karena cache tumbang adalah kerugian
 * yang jauh lebih besar daripada satu pencarian yang sedikit lebih lambat.
 */

const CACHE_KEY = 'pricing:rates'

export interface CachedRateOptions {
  readonly ttlSeconds: number
  readonly onCacheError: (error: unknown) => void
}

export function withRateCache(
  source: RateProvider,
  redis: Redis,
  options: CachedRateOptions,
): RateProvider {
  return {
    async current(): Promise<readonly ExchangeRate[]> {
      const cached = await read(redis, options.onCacheError)
      if (cached !== undefined) return cached

      const rates = await source.current()
      await write(redis, rates, options)

      return rates
    },
  }
}

async function read(
  redis: Redis,
  onCacheError: (error: unknown) => void,
): Promise<readonly ExchangeRate[] | undefined> {
  try {
    const raw = await redis.get(CACHE_KEY)
    if (raw === null) return undefined

    return JSON.parse(raw) as readonly ExchangeRate[]
  } catch (error) {
    onCacheError(error)
    return undefined
  }
}

async function write(
  redis: Redis,
  rates: readonly ExchangeRate[],
  options: CachedRateOptions,
): Promise<void> {
  try {
    await redis.set(CACHE_KEY, JSON.stringify(rates), 'EX', options.ttlSeconds)
  } catch (error) {
    options.onCacheError(error)
  }
}
