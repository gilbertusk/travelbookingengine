import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { v7 as uuidv7 } from 'uuid'
import type {
  Clock,
  IdFactory,
  LoginAttemptLimiter,
  RefreshTokenFactory,
} from '../application/ports.js'

export const systemClock: Clock = {
  now: () => new Date(),
}

export const uuidFactory: IdFactory = {
  // UUID v7 terurut menurut waktu, sehingga penyisipan tidak memfragmentasi
  // indeks seperti pada v4 yang acak sepenuhnya.
  newId: () => uuidv7(),
}

const REFRESH_TOKEN_BYTES = 32

/**
 * Refresh token: nilai acak, disimpan sebagai hash.
 *
 * SHA-256 cukup di sini, dan Argon2 justru salah: token ini punya entropi 256
 * bit dari sumber acak kriptografis, sehingga tidak ada yang bisa ditebak.
 * Argon2 melindungi dari penebakan kata sandi berentropi rendah, dan memakainya
 * di sini hanya menambah beberapa puluh milidetik pada setiap rotasi.
 */
export function createRefreshTokenFactory(ttlMs: number): RefreshTokenFactory {
  const hash = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex')

  return {
    ttlMs,
    hash,
    create() {
      const token = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url')
      return { token, hash: hash(token) }
    },
  }
}

export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')

  // timingSafeEqual menolak panjang berbeda, dan itu sendiri membocorkan
  // panjangnya. Untuk nilai berpanjang tetap seperti hash, itu tidak berarti.
  return left.length === right.length && timingSafeEqual(left, right)
}

export interface MemoryLimiterOptions {
  readonly maxFailures: number
  readonly windowMs: number
}

/**
 * Pembatas percobaan masuk dalam memori.
 *
 * Tidak dibagikan antar replika, dan itu batasan yang disengaja untuk tahap
 * ini. Pembatas terdistribusi berbasis Redis dapat menggantikannya tanpa
 * menyentuh satu baris pun use case, karena keduanya memenuhi port yang sama.
 */
export function createMemoryLoginLimiter(options: MemoryLimiterOptions): LoginAttemptLimiter {
  const failures = new Map<string, { count: number; firstAt: number }>()

  const current = (key: string, now: number): { count: number; firstAt: number } | undefined => {
    const entry = failures.get(key)
    if (entry === undefined) return undefined

    if (now - entry.firstAt > options.windowMs) {
      failures.delete(key)
      return undefined
    }

    return entry
  }

  return {
    isBlocked: async (key) => {
      await Promise.resolve()
      return (current(key, Date.now())?.count ?? 0) >= options.maxFailures
    },

    recordFailure: async (key) => {
      await Promise.resolve()
      const now = Date.now()
      const entry = current(key, now)

      if (entry === undefined) failures.set(key, { count: 1, firstAt: now })
      else entry.count += 1
    },

    reset: async (key) => {
      await Promise.resolve()
      failures.delete(key)
    },
  }
}
