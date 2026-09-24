import type { Redis } from 'ioredis'
import type { SupplierCode } from '@tbe/supplier-adapters'
import type { OutboundRateLimiter, RateLimitVerdict } from '../application/ports.js'

/**
 * Pembatas laju keluar, token bucket di Redis.
 *
 * Arahnya berlawanan dengan pembatas di api-gateway: yang di sana melindungi
 * kita dari klien, yang ini melindungi supplier dari kita (NFR-14). Sistem
 * yang menggandakan diri saat trafik naik dapat membanjiri supplier tanpa
 * sengaja, dan supplier yang tumbang karena kita adalah kerusakan yang kita
 * sendiri sebabkan.
 *
 * Token bucket, bukan jendela tetap: burst pendek pada awal pencarian —
 * lima permintaan ke lima supplier sekaligus — harus lewat, sementara laju
 * rata-ratanya tetap terjaga. Jendela tetap akan menolak burst yang sah, atau
 * mengizinkan dua kali kuota di perbatasan jendela.
 *
 * Seluruh perhitungan berjalan sebagai satu skrip Lua. Membacanya di Node
 * lalu menulis kembali berarti dua instance dapat sama-sama melihat token
 * terakhir dan sama-sama memakainya.
 */

export interface BucketPolicy {
  /** Token yang ditambahkan per detik. */
  readonly refillPerSecond: number
  /** Isi maksimum ember — inilah besar burst yang diizinkan. */
  readonly capacity: number
}

export const DEFAULT_BUCKET: BucketPolicy = { refillPerSecond: 20, capacity: 40 }

/**
 * KEYS[1] kunci ember · ARGV: kapasitas, laju isi ulang, waktu sekarang (ms), TTL
 *
 * Mengembalikan {diizinkan, sisa token, milidetik sampai satu token tersedia}.
 */
const TOKEN_BUCKET = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refillPerSecond = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])

local bucket = redis.call('HMGET', key, 'tokens', 'updatedAt')
local tokens = tonumber(bucket[1])
local updatedAt = tonumber(bucket[2])

if tokens == nil then
  tokens = capacity
  updatedAt = now
end

local elapsed = math.max(now - updatedAt, 0)
tokens = math.min(capacity, tokens + (elapsed / 1000) * refillPerSecond)

local allowed = 0
local waitMs = 0

if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  waitMs = math.ceil(((1 - tokens) / refillPerSecond) * 1000)
end

redis.call('HMSET', key, 'tokens', tokens, 'updatedAt', now)
redis.call('PEXPIRE', key, ttl)

return {allowed, math.floor(tokens), waitMs}
`

const KEY_PREFIX = 'outbound-rate'

export function createRedisRateLimiter(
  redis: Redis,
  policies: Readonly<Partial<Record<SupplierCode, BucketPolicy>>> = {},
): OutboundRateLimiter {
  return {
    async acquire(supplier: SupplierCode, nowMs: number): Promise<RateLimitVerdict> {
      const policy = policies[supplier] ?? DEFAULT_BUCKET

      // Masa simpan cukup untuk mengisi ember dari kosong sampai penuh;
      // ember yang kedaluwarsa lahir kembali dalam keadaan penuh, yang
      // merupakan bawaan yang aman bagi supplier yang lama tidak dipanggil.
      const ttlMs = Math.ceil((policy.capacity / policy.refillPerSecond) * 1_000) * 2

      const raw = (await redis.eval(
        TOKEN_BUCKET,
        1,
        `${KEY_PREFIX}:${supplier}`,
        String(policy.capacity),
        String(policy.refillPerSecond),
        String(nowMs),
        String(ttlMs),
      )) as [number, number, number]

      return { allowed: raw[0] === 1, retryAfterMs: raw[2] }
    },
  }
}
