import { RateLimitedError } from '@tbe/shared-kernel'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type { RateLimiter } from '../application/ports.js'
import { matchRoute } from '../domain/routes.js'
import { identityOf } from './authenticate.js'

/**
 * Pembatasan laju per kelas rute.
 *
 * Kunci memakai identitas pengguna bila ada, dan alamat IP bila tidak.
 * Memakai IP untuk pengguna yang sudah masuk akan menghukum seluruh kantor
 * yang berbagi satu alamat keluar; memakai identitas untuk permintaan anonim
 * mustahil, karena identitasnya belum ada.
 */

export function createRateLimitMiddleware(limiter: RateLimiter): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const route = matchRoute(req.method, req.path)

    if (route === undefined) {
      next()
      return
    }

    void limiter.consume(route.rateLimit, rateLimitKey(req, res)).then((decision) => {
      // Header standar dikirim pada setiap respons, bukan hanya saat ditolak.
      // Klien yang baik menyesuaikan kecepatannya sebelum kena batas, dan itu
      // hanya mungkin bila ia tahu sisa kuotanya.
      res.setHeader('ratelimit-limit', String(decision.limit))
      res.setHeader('ratelimit-remaining', String(decision.remaining))
      res.setHeader('ratelimit-reset', String(decision.resetAfterSeconds))

      if (decision.allowed) {
        next()
        return
      }

      res.setHeader('retry-after', String(decision.resetAfterSeconds))
      next(new RateLimitedError('Terlalu banyak permintaan. Coba lagi sebentar.'))
    }, next)
  }
}

export function rateLimitKey(req: Request, res: Response): string {
  const identity = identityOf(res)

  return identity === undefined ? `ip:${req.ip ?? 'unknown'}` : `user:${identity.userId}`
}
