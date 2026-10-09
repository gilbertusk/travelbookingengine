import { AppError, type Logger } from '@tbe/shared-kernel'
import type { ErrorRequestHandler } from 'express'

/**
 * Basis data yang penuh dijawab 503, bukan 500 (Step 22).
 *
 * Uji beban seribu price check serentak menemukannya: kolam koneksi Postgres
 * habis, Prisma menyerah memulai transaksi setelah `maxWait` (P2028), dan
 * pengguna menerima 500 INTERNAL_ERROR — galat yang berarti "ada yang rusak"
 * untuk keadaan yang sebenarnya berarti "terlalu ramai, coba lagi". 503
 * memberi tahu klien bahwa permintaan yang SAMA boleh diulang; dengan kunci
 * idempotensi yang sama, pengulangan itu aman (FR-18).
 *
 * P2024 adalah kembarannya: waktu habis menunggu koneksi dari kolam.
 */

const BUSY_CODES = new Set(['P2024', 'P2028'])

/** Detik yang disarankan sebelum mencoba lagi. */
const RETRY_AFTER_S = 1

export function databaseBusyHandler(logger: Logger): ErrorRequestHandler {
  return (error: unknown, _req, res, next) => {
    if (!isBusy(error)) {
      next(error)
      return
    }

    logger.warn({ code: error.code }, 'basis data penuh; permintaan dijawab 503 untuk diulang')
    res.setHeader('Retry-After', String(RETRY_AFTER_S))
    next(
      new AppError({
        code: 'DATABASE_BUSY',
        httpStatus: 503,
        message: 'Layanan sedang sibuk. Silakan coba lagi sebentar.',
      }),
    )
  }
}

function isBusy(error: unknown): error is { readonly code: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    BUSY_CODES.has(error.code)
  )
}
