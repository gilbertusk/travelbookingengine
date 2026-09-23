import { jwtVerify } from 'jose'
import type { TokenVerifier, VerifiedIdentity } from '../application/ports.js'

/**
 * Verifikasi access token.
 *
 * Gateway memverifikasi, service hulu mempercayai hasilnya. Konsekuensinya
 * hanya gateway dan auth-service yang perlu memegang rahasia penandatanganan —
 * sembilan service lain tidak, dan karena itu tidak dapat membocorkannya.
 */

export interface VerifierOptions {
  readonly secret: string
  readonly issuer: string
  readonly audience: string
}

export function createJoseVerifier(options: VerifierOptions): TokenVerifier {
  const key = new TextEncoder().encode(options.secret)

  return {
    async verify(token: string): Promise<VerifiedIdentity | undefined> {
      try {
        const { payload } = await jwtVerify(token, key, {
          issuer: options.issuer,
          audience: options.audience,
          // Dibatasi eksplisit. Pustaka yang mempercayai header token akan
          // menerima token bertanda tangan "none".
          algorithms: ['HS256'],
        })

        const email = payload.email
        if (payload.sub === undefined || typeof email !== 'string') return undefined

        return { userId: payload.sub, email }
      } catch {
        return undefined
      }
    },
  }
}
