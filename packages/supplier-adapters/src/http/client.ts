import { err, ok, type Result } from '@tbe/shared-kernel'
import { request } from 'undici'
import type { SupplierCode } from '../canonical/model.js'
import type { SupplierError } from '../errors/supplier-error.js'

/**
 * Klien HTTP untuk supplier.
 *
 * Yang dipusatkan di sini hanya transport: batas waktu, pembacaan badan
 * respons, dan penerjemahan kegagalan jaringan. Penerjemahan bentuk data
 * tetap milik masing-masing adapter — kalau klien ini mulai tahu bentuk
 * respons SKY, ia berhenti menjadi klien dan menjadi adapter keenam.
 *
 * Respons dengan status apa pun dikembalikan sebagai Ok. Status 409 berarti
 * hal yang berbeda pada setiap supplier, dan hanya adapter yang tahu kode apa
 * yang dikirim supplier-nya di dalam badan respons.
 */

export const OPERATIONS = ['search', 'priceCheck', 'hold', 'book', 'cancel', 'getBooking'] as const

export type Operation = (typeof OPERATIONS)[number]

export type OperationTimeouts = Readonly<Record<Operation, number>>

/**
 * Batas waktu bawaan per operasi.
 *
 * Pencarian jauh lebih ketat daripada pemesanan karena pengguna menunggu di
 * depan layar saat mencari, sementara konfirmasi pemesanan boleh memakan
 * belasan detik asal benar. Menyamakan keduanya berarti memilih salah satu
 * dari dua keburukan: pencarian yang terasa menggantung, atau pemesanan yang
 * dibatalkan sepihak padahal supplier sedang memprosesnya.
 *
 * Anggaran waktu pencarian secara keseluruhan — berapa lama fan-out ke lima
 * supplier boleh berlangsung — ditegakkan di search-service pada Step 13,
 * bukan di sini. Yang di sini hanya batas per permintaan.
 */
export const DEFAULT_TIMEOUTS: OperationTimeouts = {
  search: 4_000,
  priceCheck: 5_000,
  hold: 8_000,
  /** Paling longgar: membatalkan sepihak lebih mahal daripada menunggu. */
  book: 15_000,
  cancel: 12_000,
  getBooking: 8_000,
}

export interface SupplierHttpConfig {
  readonly baseUrl: string
  readonly timeouts?: Partial<OperationTimeouts> | undefined
}

export interface HttpRequest {
  readonly operation: Operation
  readonly method: 'GET' | 'POST' | 'DELETE'
  readonly path: string
  readonly body?: string | undefined
  readonly contentType?: string | undefined
  readonly headers?: Readonly<Record<string, string>> | undefined
  /**
   * Dikirim sebagai header standar di samping tempatnya di badan permintaan.
   * Supplier tiruan membacanya dari badan; header tetap disertakan karena
   * itulah yang diharapkan proksi dan pencatat permintaan di dunia nyata.
   */
  readonly idempotencyKey?: string | undefined
}

export interface HttpResponse {
  readonly status: number
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
  readonly text: string
}

export interface SupplierHttp {
  send(request: HttpRequest): Promise<Result<HttpResponse, SupplierError>>
}

export function createSupplierHttp(
  supplier: SupplierCode,
  config: SupplierHttpConfig,
): SupplierHttp {
  const timeouts = { ...DEFAULT_TIMEOUTS, ...config.timeouts }

  return {
    async send(outbound: HttpRequest): Promise<Result<HttpResponse, SupplierError>> {
      const timeoutMs = timeouts[outbound.operation]

      try {
        const response = await request(`${config.baseUrl}${outbound.path}`, {
          method: outbound.method,
          headers: buildHeaders(outbound),
          ...(outbound.body === undefined ? {} : { body: outbound.body }),
          headersTimeout: timeoutMs,
          bodyTimeout: timeoutMs,
        })

        return ok({
          status: response.statusCode,
          headers: response.headers,
          text: await response.body.text(),
        })
      } catch (cause) {
        return err(classifyTransportFailure(supplier, outbound.operation, timeoutMs, cause))
      }
    },
  }
}

function buildHeaders(outbound: HttpRequest): Record<string, string> {
  return {
    accept: 'application/json, text/xml;q=0.9, */*;q=0.1',
    ...(outbound.contentType === undefined ? {} : { 'content-type': outbound.contentType }),
    ...(outbound.idempotencyKey === undefined
      ? {}
      : { 'idempotency-key': outbound.idempotencyKey }),
    ...outbound.headers,
  }
}

const TIMEOUT_CODES = new Set([
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
])

/**
 * Kode yang berarti koneksi TIDAK PERNAH terbentuk: nama tidak dapat
 * diselesaikan, atau alamatnya menolak. Permintaannya pasti belum sampai.
 */
const NEVER_CONNECTED_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
])

/**
 * Tiga jawaban atas "kenapa tidak ada respons", dan hanya satu yang pasti.
 *
 * - `timeout`: supplier mungkin sudah mengerjakan permintaannya.
 * - `unavailable`: koneksi TIDAK PERNAH terbentuk — supplier pasti belum
 *   menerima apa pun, jadi `book` boleh dikirim ulang tanpa bertanya.
 * - `upstream_error` (status 0): koneksi SUDAH terbentuk lalu putus — soket
 *   ditutup, `ECONNRESET`, atau galat yang tidak dikenali. Permintaannya
 *   mungkin sudah sampai dan dikerjakan, sama tidak pastinya dengan 500.
 *
 * Versi Step 10 menggolongkan semua yang bukan batas waktu sebagai
 * `unavailable`. Step 20 menemukan akibatnya: supplier yang memutus koneksi
 * SETELAH menyimpan pemesanan akan dianggap "pasti belum menerima", dan saga
 * mengembalikan dana untuk kamar yang tetap harus dibayar. Galat yang tidak
 * dikenali kini jatuh ke sisi yang tidak pasti — menebak "pasti belum sampai"
 * adalah tebakan yang mahal bila salah, menebak "tidak pasti" hanya menambah
 * satu pertanyaan ke supplier.
 */
export function classifyTransportFailure(
  supplier: SupplierCode,
  operation: Operation,
  timeoutMs: number,
  cause: unknown,
): SupplierError {
  const code = errorCode(cause)

  if (TIMEOUT_CODES.has(code)) return { supplier, operation, kind: 'timeout', timeoutMs }
  if (NEVER_CONNECTED_CODES.has(code)) return { supplier, operation, kind: 'unavailable' }

  return { supplier, operation, kind: 'upstream_error', status: 0, code: code || 'TRANSPORT' }
}

/**
 * Kode galat jaringan, dari galat itu sendiri atau dari `cause`-nya — undici
 * kadang membungkus galat soket Node di dalam galatnya sendiri.
 */
function errorCode(error: unknown): string {
  if (typeof error !== 'object' || error === null) return ''

  const own = 'code' in error && typeof error.code === 'string' ? error.code : ''
  if (own !== '') return own

  return 'cause' in error ? errorCode(error.cause) : ''
}

export function retryAfterSeconds(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): number | undefined {
  const raw = headers['retry-after']
  const value = Array.isArray(raw) ? raw[0] : raw
  if (value === undefined) return undefined

  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined
}
