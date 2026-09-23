import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express'
import type { Logger } from 'pino'
import { NotFoundError, isAppError } from '../errors/app-error.js'
import { toErrorResponse } from '../errors/error-response.js'
import { correlationIdOf } from './correlation-middleware.js'

/**
 * Batas sistem tempat seluruh error berakhir.
 *
 * Dua hal terjadi di sini dan hanya di sini: error dicatat lengkap dengan
 * jejak tumpukan dan correlationId, lalu diubah menjadi respons yang sudah
 * dibersihkan. Tidak ada tempat lain yang boleh memutuskan apa yang tampil
 * ke pengguna — kalau keputusan itu tersebar, cepat atau lambat ada jalur
 * yang membocorkan detail internal.
 */

export function notFoundHandler(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    next(new NotFoundError(`Rute tidak ditemukan: ${req.method} ${req.path}`))
  }
}

export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (error: unknown, _req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      // Respons sudah mulai terkirim; satu-satunya hal yang benar adalah
      // menyerahkannya ke Express agar koneksinya ditutup.
      next(error)
      return
    }

    const correlationId = correlationIdOf(res)
    const { status, body } = toErrorResponse(error, correlationId)

    logError(logger, error, status)
    res.status(status).json(body)
  }
}

function logError(logger: Logger, error: unknown, status: number): void {
  const payload = {
    err: error,
    httpStatus: status,
    ...(isAppError(error) ? { errorCode: error.code, isOperational: error.isOperational } : {}),
  }

  if (status >= 500) {
    logger.error(payload, 'permintaan gagal dengan galat server')
    return
  }

  logger.warn(payload, 'permintaan ditolak')
}
