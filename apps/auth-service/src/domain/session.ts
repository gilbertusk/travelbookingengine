/**
 * Sesi refresh token dan aturan rotasinya.
 *
 * Setiap kali refresh token dipakai, token itu ditandai terpakai dan token baru
 * diterbitkan. Token yang sudah terpakai lalu muncul lagi berarti satu dari dua
 * hal: klien mengulang permintaan, atau seseorang mencuri token itu. Keduanya
 * ditangani sama — seluruh keluarga token dicabut.
 *
 * Tanpa deteksi ini, pencurian refresh token memberi penyerang akses selama
 * umur token, dan korban tidak pernah tahu.
 */

export interface RefreshSession {
  readonly id: string
  readonly userId: string
  readonly tokenHash: string
  /** Seluruh token yang lahir dari satu kali login berbagi nilai ini. */
  readonly familyId: string
  readonly expiresAt: Date
  readonly revokedAt: Date | undefined
  readonly usedAt: Date | undefined
  readonly replacedById: string | undefined
}

export type SessionProblem =
  | 'not_found'
  | 'expired'
  | 'revoked'
  /** Token yang sudah pernah dipakai muncul lagi — tanda pencurian. */
  | 'reused'

export function evaluateSession(
  session: RefreshSession | undefined,
  now: Date,
): SessionProblem | undefined {
  if (session === undefined) return 'not_found'

  // Pemakaian ulang diperiksa paling awal. Token curian yang kebetulan juga
  // sudah kedaluwarsa tetap harus memicu pencabutan keluarga, bukan sekadar
  // dilaporkan kedaluwarsa dan dilupakan.
  if (session.usedAt !== undefined) return 'reused'
  if (session.revokedAt !== undefined) return 'revoked'
  if (session.expiresAt.getTime() <= now.getTime()) return 'expired'

  return undefined
}

export function isActive(session: RefreshSession, now: Date): boolean {
  return evaluateSession(session, now) === undefined
}
