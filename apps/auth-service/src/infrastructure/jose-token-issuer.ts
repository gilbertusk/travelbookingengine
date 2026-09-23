import { SignJWT, jwtVerify } from 'jose'
import type { AccessClaims, TokenIssuer } from '../application/ports.js'

/**
 * Access token berumur pendek, ditandatangani HS256.
 *
 * Umurnya sengaja pendek karena access token tidak dapat dicabut — satu-satunya
 * cara menghentikannya adalah menunggu kedaluwarsa. Pencabutan sesungguhnya
 * terjadi pada refresh token, yang disimpan dan dapat dicabut kapan saja.
 */

export interface TokenIssuerOptions {
  readonly secret: string
  readonly issuer: string
  readonly audience: string
  readonly accessTokenTtlSeconds: number
}

export function createJoseTokenIssuer(options: TokenIssuerOptions): TokenIssuer {
  const key = new TextEncoder().encode(options.secret)

  return {
    accessTokenTtlSeconds: options.accessTokenTtlSeconds,

    async issueAccessToken(claims: AccessClaims) {
      return await new SignJWT({ email: claims.email })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(claims.sub)
        .setIssuer(options.issuer)
        .setAudience(options.audience)
        .setIssuedAt()
        .setExpirationTime(`${String(options.accessTokenTtlSeconds)}s`)
        .sign(key)
    },

    async verifyAccessToken(token: string) {
      try {
        const { payload } = await jwtVerify(token, key, {
          issuer: options.issuer,
          audience: options.audience,
          // Algoritma dibatasi secara eksplisit. Tanpa ini, token bertanda
          // tangan "none" atau algoritma lain yang lebih lemah akan diterima —
          // celah klasik pada pustaka JWT yang menerima apa pun yang tertulis
          // di header token itu sendiri.
          algorithms: ['HS256'],
        })

        const email = payload.email
        if (payload.sub === undefined || typeof email !== 'string') return undefined

        return { sub: payload.sub, email }
      } catch {
        // Tanda tangan salah, kedaluwarsa, atau bentuk rusak — semuanya berarti
        // token tidak sah, dan tidak satu pun perlu dibedakan oleh pemanggil.
        return undefined
      }
    },
  }
}
