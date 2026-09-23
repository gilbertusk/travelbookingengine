import { err, ok, type Result } from '@tbe/shared-kernel'
import type { User } from '../domain/user.js'
import type { AuthDeps } from './ports.js'

/**
 * Keluar, dan pengelolaan profil.
 */

export type LogoutOutcome = 'revoked' | 'already_inactive'

/**
 * Keluar mencabut seluruh keluarga token, bukan hanya token yang dikirim.
 *
 * Mencabut satu token saja membuat token berikutnya dalam rantai tetap hidup,
 * dan pengguna yang menekan "keluar dari perangkat ini" tetap memiliki sesi
 * aktif yang tidak ia sadari.
 */
export async function revokeSession(deps: AuthDeps, refreshToken: string): Promise<LogoutOutcome> {
  const session = await deps.sessions.findByTokenHash(deps.refreshTokens.hash(refreshToken))

  if (session === undefined) return 'already_inactive'

  const revoked = await deps.sessions.revokeFamily(session.familyId, deps.clock.now())
  return revoked > 0 ? 'revoked' : 'already_inactive'
}

export type ProfileFailure = { readonly kind: 'not_found' }

export async function getProfile(
  deps: AuthDeps,
  userId: string,
): Promise<Result<User, ProfileFailure>> {
  const user = await deps.users.findById(userId)

  return user === undefined ? err({ kind: 'not_found' }) : ok(user)
}

export async function updateProfile(
  deps: AuthDeps,
  userId: string,
  name: string,
): Promise<Result<User, ProfileFailure>> {
  const user = await deps.users.updateName(userId, name.trim())

  return user === undefined ? err({ kind: 'not_found' }) : ok(user)
}
