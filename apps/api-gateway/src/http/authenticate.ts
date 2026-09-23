import { UnauthorizedError } from '@tbe/shared-kernel'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type { TokenVerifier, VerifiedIdentity } from '../application/ports.js'
import { matchRoute } from '../domain/routes.js'

/**
 * Verifikasi token dan penentuan identitas.
 *
 * Gateway memverifikasi token untuk rute terlindungi, lalu meneruskan
 * identitasnya ke hulu. Service hulu karena itu tidak perlu memverifikasi JWT
 * lagi — dan tidak perlu memegang rahasia penandatanganannya.
 *
 * Untuk rute publik, token yang kebetulan disertakan tetap diverifikasi bila
 * ada. Endpoint publik yang juga mengenali pengguna yang sedang masuk butuh
 * itu, dan token yang tidak sah pada rute publik cukup diabaikan.
 */

const IDENTITY_KEY = 'gatewayIdentity'

export function createIdentityMiddleware(verifier: TokenVerifier): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const route = matchRoute(req.method, req.path)
    const token = bearerToken(req.header('authorization'))

    if (token === undefined) {
      if (route?.requiresAuth === true) {
        next(new UnauthorizedError())
        return
      }

      next()
      return
    }

    void verifier.verify(token).then(
      (identity) => {
        if (identity === undefined) {
          // Token tidak sah pada rute terlindungi adalah penolakan; pada rute
          // publik cukup diabaikan, karena permintaannya memang tidak
          // membutuhkan identitas.
          if (route?.requiresAuth === true) {
            next(new UnauthorizedError())
            return
          }

          next()
          return
        }

        ;(res.locals as Record<string, unknown>)[IDENTITY_KEY] = identity
        next()
      },
      (error: unknown) => {
        next(error)
      },
    )
  }
}

export function bearerToken(header: string | undefined): string | undefined {
  const [scheme, value] = (header ?? '').split(' ')

  return scheme?.toLowerCase() === 'bearer' && value !== undefined && value.length > 0
    ? value
    : undefined
}

export function identityOf(res: Response): VerifiedIdentity | undefined {
  const value = (res.locals as Record<string, unknown>)[IDENTITY_KEY]

  return typeof value === 'object' && value !== null ? (value as VerifiedIdentity) : undefined
}
