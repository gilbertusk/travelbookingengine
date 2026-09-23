import { type ErrorDetails, isAppError } from './app-error.js'

/**
 * Mengubah error apa pun menjadi respons yang aman dikirim ke klien.
 *
 * PRD NFR-15: pesan galat tidak mengungkap detail internal sistem. Aturan yang
 * ditegakkan di sini: apa pun yang berstatus 5xx dikirim dengan pesan generik,
 * termasuk error yang kita buat sendiri. Nama supplier, pesan driver database,
 * dan jejak tumpukan hanya masuk log, tidak pernah ke respons.
 */

export const GENERIC_SERVER_MESSAGE = 'Terjadi kesalahan pada sistem. Silakan coba lagi.'

export interface ErrorResponseBody {
  readonly data: null
  readonly error: {
    readonly code: string
    readonly message: string
    readonly correlationId: string
    readonly details?: ErrorDetails
  }
}

export interface ErrorResponse {
  readonly status: number
  readonly body: ErrorResponseBody
}

export function toErrorResponse(error: unknown, correlationId: string): ErrorResponse {
  if (!isAppError(error)) {
    return serverResponse('INTERNAL_ERROR', correlationId)
  }

  const isSafeToExpose = error.isOperational && error.httpStatus < 500
  if (!isSafeToExpose) {
    return serverResponse(error.code, correlationId, error.httpStatus)
  }

  return {
    status: error.httpStatus,
    body: {
      data: null,
      error: {
        code: error.code,
        message: error.message,
        correlationId,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    },
  }
}

function serverResponse(code: string, correlationId: string, status = 500): ErrorResponse {
  return {
    status,
    body: {
      data: null,
      error: { code, message: GENERIC_SERVER_MESSAGE, correlationId },
    },
  }
}
