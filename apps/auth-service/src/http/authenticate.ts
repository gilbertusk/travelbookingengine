import { UnauthorizedError } from '@tbe/shared-kernel'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type { TokenIssuer } from '../application/ports.js'

/**
 * Middleware autentikasi untuk rute yang membutuhkan pengguna.
 *
 * Identitas hasil verifikasi disimpan di res.locals, bukan ditempelkan ke req.
 * Keduanya bekerja, tetapi res.locals adalah tempat yang sudah dipakai
 * shared-kernel untuk correlation dan hasil validasi, dan satu tempat lebih
 * mudah ditelusuri daripada dua.
 */

const AUTHENTICATED_USER_KEY = 'authenticatedUser'

export interface AuthenticatedUser {
  readonly id: string
  readonly email: string
}

export function createAuthenticationMiddleware(tokens: TokenIssuer): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.header('authorization') ?? ''
    const [scheme, token] = header.split(' ')

    if (scheme?.toLowerCase() !== 'bearer' || token === undefined || token.length === 0) {
      next(new UnauthorizedError())
      return
    }

    void tokens.verifyAccessToken(token).then(
      (claims) => {
        if (claims === undefined) {
          next(new UnauthorizedError())
          return
        }

        const locals = res.locals as Record<string, unknown>
        locals[AUTHENTICATED_USER_KEY] = { id: claims.sub, email: claims.email }
        next()
      },
      (error: unknown) => {
        next(error)
      },
    )
  }
}

export function authenticatedUser(res: Response): AuthenticatedUser {
  const value = (res.locals as Record<string, unknown>)[AUTHENTICATED_USER_KEY]

  if (typeof value !== 'object' || value === null) {
    // Terjadi hanya bila rute terlindungi dipasang tanpa middleware-nya.
    // Itu cacat perangkaian, bukan kesalahan pengguna, jadi dilempar.
    throw new Error('Rute ini memerlukan createAuthenticationMiddleware')
  }

  return value as AuthenticatedUser
}
