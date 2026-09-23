import { AppError } from '@tbe/shared-kernel'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { ALLOWED_METHODS, isAllowedMethod } from '../domain/routes.js'

/**
 * Menolak metode HTTP yang tidak dipakai sistem ini.
 *
 * TRACE dan TRACK khususnya: keduanya memantulkan kembali permintaan apa
 * adanya, termasuk header, dan telah lama menjadi jalan membaca cookie yang
 * seharusnya tidak dapat dibaca skrip.
 */
export function createMethodGuard(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (isAllowedMethod(req.method)) {
      next()
      return
    }

    res.setHeader('allow', ALLOWED_METHODS.join(', '))
    next(
      new AppError({
        code: 'METHOD_NOT_ALLOWED',
        httpStatus: 405,
        message: `Metode ${req.method} tidak didukung`,
      }),
    )
  }
}
