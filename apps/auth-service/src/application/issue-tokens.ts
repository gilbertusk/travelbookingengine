import type { User } from '../domain/user.js'
import type { AuthDeps, IssuedTokens } from './ports.js'

/**
 * Menerbitkan sepasang token dan mencatat sesinya.
 *
 * familyId diteruskan saat rotasi supaya seluruh token yang lahir dari satu
 * kali login tetap terhubung. Kehilangan hubungan itu berarti pencabutan
 * keluarga saat pencurian terdeteksi hanya mencabut satu token, dan penyerang
 * tetap memegang yang berikutnya.
 */
export async function issueTokens(
  deps: AuthDeps,
  user: User,
  familyId?: string,
): Promise<IssuedTokens> {
  const now = deps.clock.now()
  const refresh = deps.refreshTokens.create()
  const sessionId = deps.ids.newId()

  await deps.sessions.create({
    id: sessionId,
    userId: user.id,
    tokenHash: refresh.hash,
    familyId: familyId ?? sessionId,
    expiresAt: new Date(now.getTime() + deps.refreshTokens.ttlMs),
    revokedAt: undefined,
    usedAt: undefined,
    replacedById: undefined,
  })

  return {
    accessToken: await deps.tokens.issueAccessToken({ sub: user.id, email: user.email }),
    refreshToken: refresh.token,
    accessTokenExpiresIn: deps.tokens.accessTokenTtlSeconds,
  }
}

/**
 * Pengenal sesi yang baru dibuat saat rotasi, dipakai untuk menandai token lama
 * sebagai tergantikan.
 */
export async function rotateTokens(
  deps: AuthDeps,
  user: User,
  previousSessionId: string,
  familyId: string,
): Promise<IssuedTokens> {
  const now = deps.clock.now()
  const refresh = deps.refreshTokens.create()
  const sessionId = deps.ids.newId()

  await deps.sessions.create({
    id: sessionId,
    userId: user.id,
    tokenHash: refresh.hash,
    familyId,
    expiresAt: new Date(now.getTime() + deps.refreshTokens.ttlMs),
    revokedAt: undefined,
    usedAt: undefined,
    replacedById: undefined,
  })

  // Token lama ditandai terpakai SETELAH penggantinya tersimpan. Urutan
  // sebaliknya membuat kegagalan di tengah meninggalkan pengguna tanpa token
  // yang masih berlaku sama sekali.
  await deps.sessions.markUsed(previousSessionId, now, sessionId)

  return {
    accessToken: await deps.tokens.issueAccessToken({ sub: user.id, email: user.email }),
    refreshToken: refresh.token,
    accessTokenExpiresIn: deps.tokens.accessTokenTtlSeconds,
  }
}
