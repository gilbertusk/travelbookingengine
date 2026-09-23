import { err, ok, type Result } from '@tbe/shared-kernel'
import { evaluateSession, type SessionProblem } from '../domain/session.js'
import { rotateTokens } from './issue-tokens.js'
import type { AuthDeps, IssuedTokens } from './ports.js'

/**
 * Rotasi refresh token, lengkap dengan deteksi pemakaian ulang.
 *
 * Inti keamanannya ada pada cabang 'reused': token yang sudah pernah dipakai
 * lalu muncul lagi berarti ada dua pihak memegang token yang sama, dan satu
 * dari keduanya bukan pemiliknya. Karena tidak ada cara membedakan mana yang
 * asli, keduanya dicabut dan pengguna harus masuk ulang.
 */

export interface RefreshInput {
  readonly refreshToken: string
}

export type RefreshFailure = {
  readonly kind: 'invalid_refresh'
  readonly reason: SessionProblem | 'user_missing'
  /** true bila pencabutan keluarga terjadi — dipakai untuk log tingkat peringatan. */
  readonly familyRevoked: boolean
}

export async function refreshSession(
  deps: AuthDeps,
  input: RefreshInput,
): Promise<Result<IssuedTokens, RefreshFailure>> {
  const tokenHash = deps.refreshTokens.hash(input.refreshToken)
  const session = await deps.sessions.findByTokenHash(tokenHash)
  const problem = evaluateSession(session, deps.clock.now())

  if (problem === 'reused' && session !== undefined) {
    await deps.sessions.revokeFamily(session.familyId, deps.clock.now())
    return err({ kind: 'invalid_refresh', reason: 'reused', familyRevoked: true })
  }

  if (problem !== undefined || session === undefined) {
    return err({
      kind: 'invalid_refresh',
      reason: problem ?? 'not_found',
      familyRevoked: false,
    })
  }

  const user = await deps.users.findById(session.userId)
  if (user === undefined) {
    // Sesi tanpa pemilik seharusnya mustahil karena kaskade penghapusan,
    // tetapi menjawabnya sebagai token sah akan lebih buruk daripada mustahil.
    await deps.sessions.revoke(session.id, deps.clock.now())
    return err({ kind: 'invalid_refresh', reason: 'user_missing', familyRevoked: false })
  }

  return ok(await rotateTokens(deps, user, session.id, session.familyId))
}
