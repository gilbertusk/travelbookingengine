import type { Email } from '../domain/email.js'
import type { PasswordHash, RawPassword } from '../domain/password.js'
import type { RefreshSession } from '../domain/session.js'
import type { User } from '../domain/user.js'

export interface Clock {
  now(): Date
}

export interface IdFactory {
  newId(): string
}

export interface UserRepository {
  findByEmail(email: Email): Promise<User | undefined>
  findById(id: string): Promise<User | undefined>
  create(input: {
    readonly id: string
    readonly email: Email
    readonly passwordHash: PasswordHash
    readonly name: string
  }): Promise<User>
  updateName(id: string, name: string): Promise<User | undefined>
}

export interface SessionRepository {
  create(session: RefreshSession): Promise<void>
  findByTokenHash(tokenHash: string): Promise<RefreshSession | undefined>
  markUsed(id: string, usedAt: Date, replacedById: string): Promise<void>
  revoke(id: string, revokedAt: Date): Promise<void>
  /** Mencabut seluruh token dari satu kali login. Mengembalikan jumlah yang dicabut. */
  revokeFamily(familyId: string, revokedAt: Date): Promise<number>
}

export interface PasswordHasher {
  hash(raw: RawPassword): Promise<PasswordHash>
  verify(hash: PasswordHash, raw: RawPassword): Promise<boolean>
}

export interface AccessClaims {
  readonly sub: string
  readonly email: string
}

export interface TokenIssuer {
  issueAccessToken(claims: AccessClaims): Promise<string>
  verifyAccessToken(token: string): Promise<AccessClaims | undefined>
  readonly accessTokenTtlSeconds: number
}

export interface RefreshTokenFactory {
  /** Nilai asli dikirim ke klien; hash-nya yang disimpan. */
  create(): { readonly token: string; readonly hash: string }
  hash(token: string): string
  readonly ttlMs: number
}

/**
 * Pembatas percobaan masuk.
 *
 * Pembatasan laju per alamat IP ada di gateway (Step 08). Yang ini berbeda dan
 * tidak dapat digantikannya: ia membatasi percobaan terhadap satu akun, dari
 * alamat mana pun. Serangan penyemprotan kata sandi memakai ribuan alamat IP
 * dan satu kata sandi — pembatas per-IP tidak melihatnya sama sekali.
 */
export interface LoginAttemptLimiter {
  isBlocked(key: string): Promise<boolean>
  recordFailure(key: string): Promise<void>
  reset(key: string): Promise<void>
}

export interface AuthDeps {
  readonly users: UserRepository
  readonly sessions: SessionRepository
  readonly hasher: PasswordHasher
  readonly tokens: TokenIssuer
  readonly refreshTokens: RefreshTokenFactory
  readonly ids: IdFactory
  readonly clock: Clock
  readonly limiter: LoginAttemptLimiter
}

export interface IssuedTokens {
  readonly accessToken: string
  readonly refreshToken: string
  readonly accessTokenExpiresIn: number
}
