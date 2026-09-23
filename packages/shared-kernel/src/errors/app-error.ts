/**
 * Hierarki error domain.
 *
 * CONVENTIONS.md bagian 5: error tak terduga dilempar dan ditangkap di batas
 * sistem. Kelas-kelas di sini membawa cukup informasi agar batas sistem dapat
 * memutuskan status HTTP dan apa yang aman ditampilkan ke pengguna, tanpa
 * pemanggil perlu tahu apa pun tentang HTTP.
 */

export type ErrorDetails = Readonly<Record<string, unknown>>

export interface AppErrorParams {
  readonly code: string
  readonly httpStatus: number
  readonly message: string
  /**
   * Error operasional adalah kegagalan yang diperkirakan terjadi pada sistem
   * yang sehat: masukan tidak sah, data tidak ditemukan, supplier sedang mati.
   * Error non-operasional menandakan cacat pemrograman, dan pesannya tidak
   * pernah dikirim ke pengguna.
   */
  readonly isOperational?: boolean | undefined
  readonly details?: ErrorDetails | undefined
  readonly cause?: unknown
}

export class AppError extends Error {
  readonly code: string
  readonly httpStatus: number
  readonly isOperational: boolean
  readonly details: ErrorDetails | undefined

  constructor(params: AppErrorParams) {
    super(params.message, params.cause === undefined ? undefined : { cause: params.cause })
    this.name = new.target.name
    this.code = params.code
    this.httpStatus = params.httpStatus
    this.isOperational = params.isOperational ?? true
    this.details = params.details
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: ErrorDetails) {
    super({ code: 'VALIDATION_ERROR', httpStatus: 400, message, details })
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Autentikasi diperlukan') {
    super({ code: 'UNAUTHORIZED', httpStatus: 401, message })
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Akses ditolak') {
    super({ code: 'FORBIDDEN', httpStatus: 403, message })
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, details?: ErrorDetails) {
    super({ code: 'NOT_FOUND', httpStatus: 404, message, details })
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: ErrorDetails) {
    super({ code: 'CONFLICT', httpStatus: 409, message, details })
  }
}

export class RateLimitedError extends AppError {
  constructor(message = 'Terlalu banyak permintaan') {
    super({ code: 'RATE_LIMITED', httpStatus: 429, message })
  }
}

/**
 * Kegagalan pada sistem pihak ketiga. Membawa nama sistemnya agar dapat
 * dicatat dan dijadikan metrik per supplier, tetapi nama itu tidak pernah
 * ikut ke respons pengguna — lihat toErrorResponse.
 */
export class UpstreamError extends AppError {
  readonly upstream: string

  constructor(params: {
    readonly upstream: string
    readonly message: string
    readonly details?: ErrorDetails | undefined
    readonly cause?: unknown
  }) {
    super({
      code: 'UPSTREAM_ERROR',
      httpStatus: 502,
      message: params.message,
      details: params.details,
      cause: params.cause,
    })
    this.upstream = params.upstream
  }
}

export class TimeoutError extends AppError {
  readonly upstream: string | undefined
  readonly timeoutMs: number

  constructor(params: {
    readonly message: string
    readonly timeoutMs: number
    readonly upstream?: string | undefined
    readonly cause?: unknown
  }) {
    super({
      code: 'TIMEOUT',
      httpStatus: 504,
      message: params.message,
      cause: params.cause,
    })
    this.upstream = params.upstream
    this.timeoutMs = params.timeoutMs
  }
}

/**
 * Konfigurasi tidak sah saat startup. Non-operasional: proses tidak boleh
 * melanjutkan hidup dengan konfigurasi yang salah.
 */
export class ConfigError extends AppError {
  constructor(message: string, details?: ErrorDetails) {
    super({
      code: 'CONFIG_ERROR',
      httpStatus: 500,
      message,
      isOperational: false,
      details,
    })
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError
}
