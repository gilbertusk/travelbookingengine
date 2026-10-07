import { UnauthorizedError } from '@tbe/shared-kernel'
import type { RequestHandler, Response } from 'express'
import { z } from 'zod'

/**
 * Identitas pengguna dari api-gateway — pola yang sama dengan booking-service.
 *
 * Gateway mewajibkan autentikasi untuk awalan /vouchers dan meneruskan
 * identitas sebagai `x-tbe-user-id`, setelah membuang header `x-tbe-*` kiriman
 * klien. Header ini dapat dipercaya DI SINI — dan hanya di sini, di balik
 * gateway.
 */
export const USER_ID_HEADER = 'x-tbe-user-id'

export type IdentityMiddleware = RequestHandler & {
  /** Pengguna yang sudah diperiksa middleware ini. Melempar bila middleware tidak dipasang. */
  value(res: Response): string
}

export const identity: IdentityMiddleware = Object.assign(
  ((req, res, next) => {
    const header = req.header(USER_ID_HEADER)
    if (header === undefined || !z.uuid().safeParse(header).success) {
      next(new UnauthorizedError())
      return
    }
    res.locals.userId = header
    next()
  }) satisfies RequestHandler,
  {
    value(res: Response): string {
      const userId: unknown = res.locals.userId
      if (typeof userId !== 'string') throw new Error('middleware identitas tidak dipasang')
      return userId
    },
  },
)
