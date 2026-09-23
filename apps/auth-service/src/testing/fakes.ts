import { createLogger, type Logger } from '@tbe/shared-kernel'
import type { Express } from 'express'
import type {
  AuthDeps,
  Clock,
  IdFactory,
  LoginAttemptLimiter,
  PasswordHasher,
  RefreshTokenFactory,
  SessionRepository,
  TokenIssuer,
  UserRepository,
} from '../application/ports.js'
import { createAuthHttpApp } from '../composition/app.js'
import { asPasswordHash, type PasswordHash, type RawPassword } from '../domain/password.js'
import type { RefreshSession } from '../domain/session.js'
import type { User } from '../domain/user.js'

/**
 * Perkakas uji. Tidak ikut ter-build — lihat exclude pada tsconfig.build.json.
 *
 * Repository dalam memori dipakai agar use case dapat diuji tanpa database.
 * Hasher dan penerbit token juga dipalsukan: Argon2 sengaja lambat, dan
 * beberapa puluh test yang masing-masing menunggu seratus milidetik membuat
 * rangkaian uji terlalu lambat untuk dijalankan terus-menerus.
 *
 * Adapter sungguhnya tetap diuji, terpisah, di berkasnya sendiri.
 */

export function silentLogger(): Logger {
  return createLogger({
    serviceName: 'auth-test',
    level: 'silent',
    destination: {
      write(): void {
        // keluaran log tidak diuji di sini
      },
    },
  })
}

export function createMemoryUserRepository(): UserRepository {
  const byId = new Map<string, User>()
  const byEmail = new Map<string, string>()

  return {
    findByEmail: async (email) => {
      await Promise.resolve()
      const id = byEmail.get(email)
      return id === undefined ? undefined : byId.get(id)
    },

    findById: async (id) => {
      await Promise.resolve()
      return byId.get(id)
    },

    create: async (input) => {
      await Promise.resolve()
      const now = new Date()
      const user: User = { ...input, createdAt: now, updatedAt: now }
      byId.set(user.id, user)
      byEmail.set(user.email, user.id)
      return user
    },

    updateName: async (id, name) => {
      await Promise.resolve()
      const existing = byId.get(id)
      if (existing === undefined) return undefined

      const updated: User = { ...existing, name, updatedAt: new Date() }
      byId.set(id, updated)
      return updated
    },
  }
}

export function createMemorySessionRepository(): SessionRepository {
  const byId = new Map<string, RefreshSession>()
  const byHash = new Map<string, string>()

  const put = (session: RefreshSession): void => {
    byId.set(session.id, session)
    byHash.set(session.tokenHash, session.id)
  }

  return {
    create: async (session) => {
      await Promise.resolve()
      put(session)
    },

    findByTokenHash: async (tokenHash) => {
      await Promise.resolve()
      const id = byHash.get(tokenHash)
      return id === undefined ? undefined : byId.get(id)
    },

    markUsed: async (id, usedAt, replacedById) => {
      await Promise.resolve()
      const existing = byId.get(id)
      if (existing !== undefined) put({ ...existing, usedAt, replacedById })
    },

    revoke: async (id, revokedAt) => {
      await Promise.resolve()
      const existing = byId.get(id)
      if (existing !== undefined) put({ ...existing, revokedAt })
    },

    revokeFamily: async (familyId, revokedAt) => {
      await Promise.resolve()
      let revoked = 0

      for (const session of [...byId.values()]) {
        if (session.familyId !== familyId || session.revokedAt !== undefined) continue
        put({ ...session, revokedAt })
        revoked += 1
      }

      return revoked
    },
  }
}

/** Hasher palsu yang tetap membedakan kata sandi benar dan salah. */
export function createFakeHasher(): PasswordHasher {
  return {
    hash: async (raw: RawPassword) => {
      await Promise.resolve()
      return asPasswordHash(`fake$${raw}`)
    },
    verify: async (hash: PasswordHash, raw: RawPassword) => {
      await Promise.resolve()
      return hash === `fake$${raw}`
    },
  }
}

export function createFakeTokenIssuer(ttlSeconds = 900): TokenIssuer {
  return {
    accessTokenTtlSeconds: ttlSeconds,
    issueAccessToken: async (claims) => {
      await Promise.resolve()
      return `access.${claims.sub}.${claims.email}`
    },
    verifyAccessToken: async (token) => {
      await Promise.resolve()
      const [prefix, sub, email] = token.split('.')
      return prefix === 'access' && sub !== undefined && email !== undefined
        ? { sub, email }
        : undefined
    },
  }
}

export function createSequentialIds(prefix = 'id'): IdFactory {
  let counter = 0

  return {
    newId: () => {
      counter += 1
      return `${prefix}-${String(counter).padStart(4, '0')}`
    },
  }
}

export function createFakeRefreshTokens(ttlMs: number): RefreshTokenFactory {
  let counter = 0

  return {
    ttlMs,
    hash: (token) => `hash(${token})`,
    create: () => {
      counter += 1
      const token = `refresh-${String(counter).padStart(4, '0')}`
      return { token, hash: `hash(${token})` }
    },
  }
}

export interface ControllableClock extends Clock {
  advance(ms: number): void
}

export function createControllableClock(
  startMs = Date.parse('2026-09-23T10:00:00Z'),
): ControllableClock {
  let current = startMs

  return {
    now: () => new Date(current),
    advance: (ms) => {
      current += ms
    },
  }
}

export function createPermissiveLimiter(): LoginAttemptLimiter {
  return {
    isBlocked: async () => {
      await Promise.resolve()
      return false
    },
    recordFailure: async () => {
      await Promise.resolve()
    },
    reset: async () => {
      await Promise.resolve()
    },
  }
}

export const DAY_MS = 86_400_000

export interface AuthHarness {
  readonly deps: AuthDeps
  readonly clock: ControllableClock
  readonly app: Express
}

export function createAuthHarness(overrides: Partial<AuthDeps> = {}): AuthHarness {
  const clock = createControllableClock()
  const logger = silentLogger()

  const deps: AuthDeps = {
    users: createMemoryUserRepository(),
    sessions: createMemorySessionRepository(),
    hasher: createFakeHasher(),
    tokens: createFakeTokenIssuer(),
    refreshTokens: createFakeRefreshTokens(30 * DAY_MS),
    ids: createSequentialIds(),
    clock,
    limiter: createPermissiveLimiter(),
    ...overrides,
  }

  const { app } = createAuthHttpApp({ deps, logger, serviceName: 'auth-test' })

  return { deps, clock, app }
}
