import type { SupplierError, SupplierErrorKind } from '@tbe/supplier-adapters'

/**
 * Kebijakan percobaan ulang.
 *
 * Seluruhnya diturunkan dari jenis kegagalan yang sudah dibedakan Step 10.
 * Itulah sebabnya pembedaan di sana terlihat berlebihan dan ternyata menjadi
 * fondasi: tanpa jenis, satu-satunya kebijakan yang dapat ditulis adalah
 * "coba lagi semuanya" atau "jangan coba lagi apa pun".
 *
 * Operasi yang mengubah keadaan tidak diatur di sini. Lihat [confirm-booking].
 */

export interface RetryPolicy {
  readonly maxAttempts: number
  readonly baseDelayMs: number
  readonly maxDelayMs: number
  /**
   * Jeda lebih panjang untuk rate_limited: supplier sudah menyatakan bahwa
   * kita terlalu cepat, dan mencoba lagi dengan jeda biasa berarti tidak
   * mendengarkan.
   */
  readonly rateLimitedDelayMs: number
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 4_000,
  rateLimitedDelayMs: 2_000,
}

/**
 * Jenis kegagalan yang jawabannya mungkin berbeda bila ditanyakan lagi.
 *
 * `invalid_response` sengaja TIDAK di sini. Supplier yang mengirim isi tidak
 * dapat diurai kemungkinan besar akan mengirimkannya lagi; yang dibutuhkan
 * adalah orang yang memperbaikinya, bukan percobaan kedua yang menutupi
 * gejalanya di log.
 */
const RETRYABLE: ReadonlySet<SupplierErrorKind> = new Set([
  'timeout',
  'unavailable',
  'rate_limited',
  'upstream_error',
])

export type RetryDecision =
  | { readonly retry: true; readonly delayMs: number; readonly nextAttempt: number }
  | { readonly retry: false; readonly reason: 'not_retryable' | 'attempts_exhausted' }

/** Bilangan pada [0, 1). Disuntikkan supaya jitter dapat diuji. */
export type RandomSource = () => number

export function decideRetry(
  error: SupplierError,
  attempt: number,
  policy: RetryPolicy,
  random: RandomSource,
): RetryDecision {
  if (!RETRYABLE.has(error.kind)) return { retry: false, reason: 'not_retryable' }
  if (attempt >= policy.maxAttempts) return { retry: false, reason: 'attempts_exhausted' }

  return {
    retry: true,
    delayMs: delayFor(error, attempt, policy, random),
    nextAttempt: attempt + 1,
  }
}

/**
 * Backoff eksponensial dengan jitter penuh.
 *
 * Jitter bukan hiasan. Tanpa jitter, seluruh permintaan yang gagal bersamaan
 * akan dicoba ulang bersamaan juga — supplier yang baru saja tumbang menerima
 * gelombang kedua tepat pada detik yang sama, dan tumbang lagi. Jitter penuh
 * menyebarkan percobaan ke seluruh rentang, bukan menumpuknya di satu titik.
 */
export function delayFor(
  error: SupplierError,
  attempt: number,
  policy: RetryPolicy,
  random: RandomSource,
): number {
  if (error.kind === 'rate_limited') return honourRetryAfter(error, policy, random)

  const exponential = Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs)

  return Math.round(random() * exponential)
}

/**
 * Supplier yang menyebut `Retry-After` sedang memberi tahu kapan ia siap.
 * Menunggu lebih sebentar dari itu adalah cara tercepat membuat pembatasan
 * lajunya menjadi pemblokiran.
 */
function honourRetryAfter(error: SupplierError, policy: RetryPolicy, random: RandomSource): number {
  const requested =
    error.kind === 'rate_limited' && error.retryAfterSeconds !== undefined
      ? error.retryAfterSeconds * 1_000
      : policy.rateLimitedDelayMs

  // Jitter tetap ditambahkan di atas jeda yang diminta, bukan menggantikannya.
  return requested + Math.round(random() * policy.baseDelayMs)
}
