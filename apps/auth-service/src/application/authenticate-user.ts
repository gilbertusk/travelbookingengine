import { err, ok, type Result } from '@tbe/shared-kernel'
import { createEmail, normalizeEmail } from '../domain/email.js'
import { asPasswordHash, asRawPassword } from '../domain/password.js'
import type { User } from '../domain/user.js'
import { issueTokens } from './issue-tokens.js'
import type { AuthDeps, IssuedTokens } from './ports.js'

/**
 * Hash palsu yang bentuknya sah, dipakai ketika akun tidak ditemukan.
 *
 * Tanpa verifikasi palsu ini, permintaan untuk surel yang tidak terdaftar
 * kembali jauh lebih cepat daripada yang terdaftar — Argon2 sengaja lambat.
 * Selisih waktu itu cukup untuk memetakan siapa saja yang punya akun, tanpa
 * perlu menebak satu pun kata sandi.
 */
const DUMMY_HASH = asPasswordHash(
  '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHR2YWx1ZQ$0000000000000000000000000000000000000000000',
)

export interface LoginInput {
  readonly email: string
  readonly password: string
}

export type LoginFailure =
  /** Satu galat untuk surel tidak terdaftar DAN kata sandi salah. */
  { readonly kind: 'invalid_credentials' } | { readonly kind: 'too_many_attempts' }

export interface LoginSuccess {
  readonly user: User
  readonly tokens: IssuedTokens
}

export async function authenticateUser(
  deps: AuthDeps,
  input: LoginInput,
): Promise<Result<LoginSuccess, LoginFailure>> {
  const key = normalizeEmail(input.email)

  if (await deps.limiter.isBlocked(key)) {
    return err({ kind: 'too_many_attempts' })
  }

  const email = createEmail(input.email)
  const user = email.ok ? await deps.users.findByEmail(email.value) : undefined
  const raw = asRawPassword(input.password)

  // Verifikasi dijalankan apa pun hasil pencarian akun. Melewatinya ketika
  // akun tidak ada adalah kebocoran waktu yang paling sering terjadi pada
  // endpoint masuk.
  const matches = await deps.hasher.verify(user?.passwordHash ?? DUMMY_HASH, raw)

  if (user === undefined || !matches) {
    await deps.limiter.recordFailure(key)
    return err({ kind: 'invalid_credentials' })
  }

  await deps.limiter.reset(key)
  return ok({ user, tokens: await issueTokens(deps, user) })
}
