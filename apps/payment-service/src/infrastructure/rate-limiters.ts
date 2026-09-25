import type { Redis } from 'ioredis'
import {
  RateLimiterMemory,
  RateLimiterRedis,
  type RateLimiterAbstract,
  type RateLimiterRes,
} from 'rate-limiter-flexible'
import type { RateLimitDecision, WebhookRateLimiter } from '../application/ports.js'

/**
 * Pembatasan laju endpoint webhook.
 *
 * Dua implementasi memenuhi port yang sama, sama seperti di api-gateway. Yang
 * berbasis Redis dipakai saat berjalan, karena pembatas dalam memori tidak
 * berarti apa-apa begitu service digandakan: sepuluh replika masing-masing
 * mengizinkan kuota penuh, dan batasnya menjadi sepuluh kali lipat tanpa ada
 * yang menyadarinya.
 *
 * Angkanya jauh lebih longgar daripada pembatas publik di gateway, dan itu
 * disengaja: yang memanggil endpoint ini adalah PENYEDIA, yang mengirim
 * notifikasi berulang sebagai perilaku normal. Pembatas yang terlalu ketat akan
 * menolak notifikasi yang sah, dan notifikasi yang sah yang ditolak berarti
 * pembayaran yang tertinggal PENDING sampai penyedia mencoba lagi.
 *
 * Yang dilindungi bukan basis data, melainkan CPU: setiap notifikasi palsu
 * menghabiskan satu perhitungan SHA-512, dan pembatas ini berjalan sebelum
 * perhitungan itu.
 */

export interface WebhookRateLimitPolicy {
  readonly points: number
  readonly durationSeconds: number
}

export const DEFAULT_WEBHOOK_POLICY: WebhookRateLimitPolicy = {
  points: 600,
  durationSeconds: 60,
}

function toDecision(
  policy: WebhookRateLimitPolicy,
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

function build(policy: WebhookRateLimitPolicy, limiter: RateLimiterAbstract): WebhookRateLimiter {
  return {
    async consume(key) {
      try {
        return toDecision(policy, await limiter.consume(key), true)
      } catch (rejection) {
        // rate-limiter-flexible MELEMPAR RateLimiterRes ketika kuota habis. Nilai
        // yang dilempar itu bukan galat, melainkan jawabannya.
        if (isRateLimiterRes(rejection)) return toDecision(policy, rejection, false)

        throw rejection
      }
    },
  }
}

function isRateLimiterRes(value: unknown): value is RateLimiterRes {
  return typeof value === 'object' && value !== null && 'msBeforeNext' in value
}

export function createMemoryWebhookRateLimiter(
  policy: WebhookRateLimitPolicy = DEFAULT_WEBHOOK_POLICY,
): WebhookRateLimiter {
  return build(
    policy,
    new RateLimiterMemory({
      keyPrefix: 'rl:webhook',
      points: policy.points,
      duration: policy.durationSeconds,
    }),
  )
}

export function createRedisWebhookRateLimiter(
  redis: Redis,
  policy: WebhookRateLimitPolicy = DEFAULT_WEBHOOK_POLICY,
): WebhookRateLimiter {
  return build(
    policy,
    new RateLimiterRedis({
      storeClient: redis,
      keyPrefix: 'rl:webhook',
      points: policy.points,
      duration: policy.durationSeconds,
    }),
  )
}
