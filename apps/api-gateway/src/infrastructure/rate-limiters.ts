import type { Redis } from 'ioredis'
import {
  RateLimiterMemory,
  RateLimiterRedis,
  type RateLimiterAbstract,
  type RateLimiterRes,
} from 'rate-limiter-flexible'
import type { RateLimitDecision, RateLimiter } from '../application/ports.js'
import type { RateLimitClass } from '../domain/routes.js'

/**
 * Pembatas laju.
 *
 * Dua implementasi memenuhi port yang sama. Yang berbasis Redis dipakai saat
 * berjalan, karena pembatas dalam memori tidak berarti apa-apa begitu gateway
 * digandakan: sepuluh replika masing-masing mengizinkan kuota penuh, dan
 * batasnya menjadi sepuluh kali lipat tanpa ada yang menyadarinya.
 *
 * Yang dalam memori dipakai pengujian, dan sengaja tetap ada: pengujian yang
 * membutuhkan Redis berjalan tidak akan dijalankan sesering yang seharusnya.
 */

export interface RateLimitPolicy {
  readonly points: number
  readonly durationSeconds: number
}

export const DEFAULT_POLICIES: Readonly<Record<RateLimitClass, RateLimitPolicy>> = {
  /** Anonim: cukup untuk menjelajah, tidak cukup untuk mengikis seluruh katalog. */
  public: { points: 120, durationSeconds: 60 },
  authenticated: { points: 300, durationSeconds: 60 },
  /** Pencarian mahal — setiap permintaan menembak lima supplier. */
  search: { points: 40, durationSeconds: 60 },
  /**
   * Masuk, daftar, dan refresh. Ketat, karena inilah pintu yang diserang
   * dengan penebakan kata sandi.
   */
  sensitive: { points: 10, durationSeconds: 60 },
}

function toDecision(
  policy: RateLimitPolicy,
  result: RateLimiterRes,
  allowed: boolean,
): RateLimitDecision {
  return {
    allowed,
    limit: policy.points,
    remaining: Math.max(result.remainingPoints, 0),
    resetAfterSeconds: Math.ceil(result.msBeforeNext / 1_000),
  }
}

function build(
  policies: Readonly<Record<RateLimitClass, RateLimitPolicy>>,
  make: (limitClass: RateLimitClass, policy: RateLimitPolicy) => RateLimiterAbstract,
): RateLimiter {
  const limiters = new Map<RateLimitClass, RateLimiterAbstract>(
    Object.entries(policies).map(([limitClass, policy]) => [
      limitClass as RateLimitClass,
      make(limitClass as RateLimitClass, policy),
    ]),
  )

  return {
    async consume(limitClass, key) {
      const policy = policies[limitClass]
      const limiter = limiters.get(limitClass)

      if (limiter === undefined) {
        throw new Error(`Tidak ada pembatas untuk kelas "${limitClass}"`)
      }

      try {
        return toDecision(policy, await limiter.consume(key), true)
      } catch (rejection) {
        // rate-limiter-flexible melempar RateLimiterRes ketika kuota habis.
        // Nilai yang dilempar itu bukan galat, melainkan jawabannya.
        if (isRateLimiterRes(rejection)) return toDecision(policy, rejection, false)
        throw rejection
      }
    },
  }
}

function isRateLimiterRes(value: unknown): value is RateLimiterRes {
  return typeof value === 'object' && value !== null && 'msBeforeNext' in value
}

export function createMemoryRateLimiter(
  policies: Readonly<Record<RateLimitClass, RateLimitPolicy>> = DEFAULT_POLICIES,
): RateLimiter {
  return build(
    policies,
    (limitClass, policy) =>
      new RateLimiterMemory({
        keyPrefix: `rl:${limitClass}`,
        points: policy.points,
        duration: policy.durationSeconds,
      }),
  )
}

export function createRedisRateLimiter(
  redis: Redis,
  policies: Readonly<Record<RateLimitClass, RateLimitPolicy>> = DEFAULT_POLICIES,
): RateLimiter {
  return build(
    policies,
    (limitClass, policy) =>
      new RateLimiterRedis({
        storeClient: redis,
        keyPrefix: `rl:${limitClass}`,
        points: policy.points,
        duration: policy.durationSeconds,
      }),
  )
}
