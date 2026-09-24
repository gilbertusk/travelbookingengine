import type { SupplierCode } from '../canonical/model.js'
import type { SupplierError } from '../errors/supplier-error.js'
import { retryAfterSeconds, type HttpResponse, type Operation } from './client.js'

/**
 * Menerjemahkan respons gagal menjadi SupplierError.
 *
 * Status HTTP saja tidak cukup. Kelima supplier sepakat memakai 409 untuk
 * "permintaanmu sah tetapi keadaannya tidak memungkinkan", dan tidak satu pun
 * sepakat soal apa artinya — kamar habis, hold kedaluwarsa, harga berubah, dan
 * pemesanan sudah dibatalkan semuanya datang sebagai 409. Kode di dalam badan
 * responslah yang membedakan, dan hanya adapter yang tahu di mana kode itu
 * berada pada supplier-nya.
 */

export interface FailureContext {
  readonly supplier: SupplierCode
  readonly operation: Operation
  readonly response: HttpResponse
  /** Kode galat yang sudah digali adapter dari badan respons. */
  readonly code?: string | undefined
}

/** Kode 409 yang artinya sama di seluruh supplier tiruan. */
const CONFLICT_KINDS: Readonly<Record<string, SupplierError['kind']>> = {
  SOLD_OUT: 'sold_out',
  PRICE_CHANGED: 'price_changed',
  HOLD_EXPIRED: 'hold_expired',
  ALREADY_CANCELLED: 'already_cancelled',
}

export function mapHttpFailure(context: FailureContext): SupplierError {
  const { supplier, operation, response, code } = context
  const base = { supplier, operation } as const

  if (response.status === 404) return { ...base, kind: 'not_found', what: code ?? 'resource' }

  if (response.status === 409) {
    const kind = code === undefined ? undefined : CONFLICT_KINDS[code]

    // Konflik yang kodenya tidak dikenali bukan hal yang boleh ditebak.
    // Menganggapnya sold_out akan membuat pencarian menyembunyikan kamar yang
    // sebenarnya ada; menganggapnya galat membuatnya terlihat di log.
    return kind === undefined
      ? { ...base, kind: 'upstream_error', status: 409, code }
      : ({ ...base, kind } as SupplierError)
  }

  if (response.status === 429) {
    return { ...base, kind: 'rate_limited', retryAfterSeconds: retryAfterSeconds(response.headers) }
  }

  if (response.status === 503) {
    return { ...base, kind: 'unavailable', retryAfterSeconds: retryAfterSeconds(response.headers) }
  }

  if (response.status === 408) return { ...base, kind: 'timeout', timeoutMs: 0 }

  return { ...base, kind: 'upstream_error', status: response.status, code }
}

export function invalidResponse(
  supplier: SupplierCode,
  operation: Operation,
  reason: string,
): SupplierError {
  return { supplier, operation, kind: 'invalid_response', reason }
}
