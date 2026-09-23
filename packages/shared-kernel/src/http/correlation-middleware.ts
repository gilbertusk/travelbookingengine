import type { NextFunction, Request, RequestHandler, Response } from 'express'
import {
  CORRELATION_HEADER,
  newCorrelationId,
  runWithCorrelation,
} from '../correlation/correlation.js'

/**
 * Membangun konteks correlation untuk setiap permintaan masuk.
 *
 * Correlation ID dari klien diterima agar penelusuran dapat dimulai di sisi
 * frontend, tetapi tidak dipercaya begitu saja: nilainya ikut masuk ke log dan
 * ke header respons, sehingga nilai yang terlalu panjang atau memuat karakter
 * kendali dapat merusak log terstruktur. Nilai yang tidak sesuai bentuk
 * diabaikan diam-diam dan diganti yang baru.
 */

const MAX_CORRELATION_ID_LENGTH = 128
const SAFE_CORRELATION_ID = /^[A-Za-z0-9_.:-]+$/

export function isAcceptableCorrelationId(value: string | undefined): value is string {
  return (
    value !== undefined &&
    value.length > 0 &&
    value.length <= MAX_CORRELATION_ID_LENGTH &&
    SAFE_CORRELATION_ID.test(value)
  )
}

export function correlationMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const incoming = req.header(CORRELATION_HEADER)
    const correlationId = isAcceptableCorrelationId(incoming) ? incoming : newCorrelationId()

    res.setHeader(CORRELATION_HEADER, correlationId)
    // Dibutuhkan penangan galat, yang berjalan setelah konteks async berakhir
    // pada sebagian jalur kegagalan Express.
    res.locals.correlationId = correlationId

    runWithCorrelation(correlationId, () => {
      next()
    })
  }
}

export function correlationIdOf(res: Response): string {
  const value: unknown = res.locals.correlationId
  return typeof value === 'string' ? value : 'unknown'
}
