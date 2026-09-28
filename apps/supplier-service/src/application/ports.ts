import type { SupplierCode, SupplierError, SupplierGateway } from '@tbe/supplier-adapters'
import type { CircuitDecision, CircuitPolicy, CircuitState, Transition } from '../domain/circuit.js'
import type { RetryPolicy } from '../domain/retry-policy.js'

/**
 * Port yang dibutuhkan lapisan ketahanan.
 *
 * Seluruhnya punya implementasi dalam memori untuk pengujian dan implementasi
 * Redis atau Prisma untuk saat berjalan. Yang penting bukan kemudahan
 * pengujiannya — melainkan bahwa keputusan ketahanan, bagian yang paling
 * sulit dibuat benar, dapat dibuktikan tanpa satu proses pun berjalan.
 */

/** Identitas satu pemutus: satu per supplier per operasi. */
export interface CircuitKey {
  readonly supplier: SupplierCode
  readonly operation: string
}

export interface CircuitStore {
  /**
   * Apakah panggilan boleh berjalan, tanpa mengubah apa pun.
   *
   * Dipisahkan dari pencatatan hasil karena keduanya terjadi pada saat yang
   * berbeda: yang ini sebelum panggilan, yang berikutnya sesudahnya.
   */
  decide(key: CircuitKey, policy: CircuitPolicy, nowMs: number): Promise<CircuitDecision>

  /**
   * Mencatat hasil dan mengembalikan transisinya.
   *
   * WAJIB atomik terhadap instance lain. Baca-ubah-tulis yang tidak atomik
   * membuat dua instance yang gagal bersamaan sama-sama membaca hitungan
   * lama, dan pemutus tidak pernah mencapai ambangnya.
   */
  record(
    key: CircuitKey,
    outcome: 'success' | 'failure',
    policy: CircuitPolicy,
    nowMs: number,
  ): Promise<Transition>
}

export interface RateLimitVerdict {
  readonly allowed: boolean
  /** Berapa lama lagi sebelum satu token tersedia, bila ditolak. */
  readonly retryAfterMs: number
}

export interface OutboundRateLimiter {
  /**
   * Mengambil satu token untuk memanggil supplier.
   *
   * Ini pembatasan laju KELUAR: melindungi supplier dari dibanjiri sistem
   * kita sendiri (NFR-14). Berbeda arah dari pembatasan di api-gateway, yang
   * melindungi kita dari klien.
   */
  acquire(supplier: SupplierCode, nowMs: number): Promise<RateLimitVerdict>
}

export interface RequestLogEntry {
  readonly supplier: SupplierCode
  readonly operation: string
  readonly outcome: 'success' | 'failure'
  readonly errorKind?: string | undefined
  readonly attemptNumber: number
  readonly latencyMs: number
  readonly requestPayload?: unknown
  readonly responsePayload?: unknown
  readonly idempotencyKey?: string | undefined
  readonly correlationId?: string | undefined
}

export interface RequestLog {
  record(entry: RequestLogEntry): Promise<void>
}

export interface SupplierEvents {
  degraded(supplier: SupplierCode, state: 'open' | 'half_open', reason: string): Promise<void>
  recovered(supplier: SupplierCode): Promise<void>
}

/**
 * Jawaban atas perintah `supplier.confirm`, diumumkan kepada saga (Step 19).
 *
 * Sebelum Step 19 hasil konfirmasi hanya masuk log, dan booking-service tidak
 * punya cara mengetahui apakah kamar sudah terjamin. Tiga jawaban, bukan dua:
 * `uncertain` berarti pemesanan MUNGKIN sudah terbentuk, dan saga yang
 * memperlakukannya sebagai penolakan akan mengembalikan dana untuk kamar yang
 * tetap harus dibayar platform (US-05).
 */
export interface ConfirmReplies {
  confirmed(reply: {
    readonly bookingId: string
    readonly supplier: SupplierCode
    readonly supplierRef: string
    readonly adopted: boolean
  }): Promise<void>
  rejected(reply: {
    readonly bookingId: string
    readonly supplier: SupplierCode
    readonly reason: string
  }): Promise<void>
  uncertain(reply: {
    readonly bookingId: string
    readonly supplier: SupplierCode
    readonly idempotencyKey: string
    readonly reason: string
  }): Promise<void>
}

export interface SupplierMetrics {
  observeRequest(params: {
    readonly supplier: SupplierCode
    readonly operation: string
    readonly outcome: string
    readonly seconds: number
  }): void
  setCircuitState(supplier: SupplierCode, operation: string, state: CircuitState): void
  countRetry(supplier: SupplierCode, operation: string, errorKind: string): void
}

/** Konfigurasi satu supplier, sebagaimana tersimpan. */
export interface SupplierSettings {
  readonly code: SupplierCode
  readonly name: string
  readonly isActive: boolean
  readonly circuit: CircuitPolicy
  readonly retry: RetryPolicy
}

/**
 * Perubahan sebagian pada kebijakan pemutus.
 *
 * Ditulis eksplisit, bukan `Partial<CircuitPolicy>`, karena
 * `exactOptionalPropertyTypes` membedakan "tidak ada" dari "ada tetapi
 * undefined" — dan nilai yang datang dari JSON selalu yang kedua.
 */
export interface CircuitPolicyPatch {
  readonly failureThreshold?: number | undefined
  readonly windowMs?: number | undefined
  readonly openDurationMs?: number | undefined
  readonly successesToClose?: number | undefined
}

export interface SupplierDirectory {
  list(): Promise<readonly SupplierSettings[]>
  get(code: SupplierCode): Promise<SupplierSettings | undefined>
  update(
    code: SupplierCode,
    patch: {
      readonly isActive?: boolean | undefined
      readonly circuit?: CircuitPolicyPatch | undefined
    },
  ): Promise<SupplierSettings | undefined>
}

export interface Clock {
  now(): number
}

export interface Sleeper {
  sleep(ms: number): Promise<void>
}

export interface SupplierRegistryPort {
  get(code: SupplierCode): SupplierGateway
  all(): readonly SupplierGateway[]
}

export interface ResilienceDeps {
  readonly registry: SupplierRegistryPort
  readonly circuits: CircuitStore
  readonly rateLimiter: OutboundRateLimiter
  readonly requestLog: RequestLog
  readonly events: SupplierEvents
  readonly metrics: SupplierMetrics
  readonly directory: SupplierDirectory
  readonly clock: Clock
  readonly sleeper: Sleeper
  readonly random: () => number
}

/**
 * Kegagalan yang dihitung pemutus sirkuit.
 *
 * Kamar habis BUKAN kegagalan supplier — itu jawaban yang benar dari supplier
 * yang sehat. Menghitungnya akan membuka pemutus tepat pada saat permintaan
 * sedang tinggi, yaitu saat supplier paling dibutuhkan.
 *
 * `rate_limited` juga tidak dihitung: supplier sedang melindungi dirinya, dan
 * yang harus menyesuaikan adalah pembatas laju keluar kita, bukan pemutus.
 */
export function countsAsCircuitFailure(error: SupplierError): boolean {
  switch (error.kind) {
    case 'timeout':
    case 'unavailable':
    case 'upstream_error':
    case 'invalid_response':
      return true
    case 'rate_limited':
    case 'not_found':
    case 'sold_out':
    case 'price_changed':
    case 'hold_expired':
    case 'already_cancelled':
      return false
  }
}
