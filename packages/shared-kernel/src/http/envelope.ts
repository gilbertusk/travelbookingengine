/**
 * Bentuk respons baku untuk seluruh service.
 *
 * Satu bentuk untuk semua endpoint berarti klien menulis satu penanganan galat,
 * bukan satu per endpoint. Bentuk galatnya didefinisikan di errors/error-response.ts
 * agar tetap konsisten meski dihasilkan dari jalur yang berbeda.
 */

export interface PaginationMeta {
  readonly totalItems: number
  readonly page: number
  readonly limit: number
}

export interface SuccessResponse<T> {
  readonly data: T
  readonly error: null
  readonly meta?: PaginationMeta
}

export function success<T>(data: T, meta?: PaginationMeta): SuccessResponse<T> {
  return meta === undefined ? { data, error: null } : { data, error: null, meta }
}
