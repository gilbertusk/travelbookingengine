import { AppError, ValidationError } from '@tbe/shared-kernel'

/**
 * Kebijakan percobaan ulang untuk perintah.
 *
 * Keputusan pentingnya bukan berapa kali mencoba, melainkan **apa yang layak
 * dicoba ulang**. Pesan yang bentuknya salah tidak akan pernah menjadi benar
 * dengan menunggu, dan mencobanya berulang kali hanya menghabiskan kuota
 * percobaan sambil menunda pesan lain di belakangnya.
 */

export interface RetryTier {
  readonly name: string
  readonly delayMs: number
}

/**
 * Jenjang terakhir, dinamai sendiri. Dipakai consumer untuk menunda ulang
 * perintah yang kabar dead letter-nya gagal disampaikan (Step 19) — tanpa
 * mengindeks larik yang, menurut tipenya, boleh saja kosong.
 */
export const LAST_RETRY_TIER: RetryTier = { name: 't3', delayMs: 120_000 }

export const RETRY_TIERS: readonly RetryTier[] = [
  { name: 't1', delayMs: 5_000 },
  { name: 't2', delayMs: 30_000 },
  LAST_RETRY_TIER,
]

export const RETRY_COUNT_HEADER = 'x-tbe-retry-count'

export type Disposition =
  | { readonly kind: 'retry'; readonly tier: RetryTier; readonly attempt: number }
  | { readonly kind: 'dead_letter'; readonly reason: 'exhausted' | 'not_retryable' }

/**
 * Berapa kali pesan ini sudah dicoba, dibaca dari header yang kita pasang
 * sendiri.
 *
 * Sengaja tidak memakai header `x-death` milik RabbitMQ: nilainya dihitung per
 * antrian, sehingga pesan yang melewati tiga antrian tunda berbeda punya tiga
 * hitungan terpisah dan tidak satu pun mewakili jumlah percobaan sebenarnya.
 */
export function attemptsSoFar(headers: Readonly<Record<string, unknown>>): number {
  const raw = headers[RETRY_COUNT_HEADER]
  const parsed = typeof raw === 'number' ? raw : Number.parseInt(headerString(raw), 10)

  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

/**
 * Header RabbitMQ tiba sebagai string, angka, atau Buffer tergantung klien
 * yang menerbitkannya. Ketiganya dinormalkan di sini; bentuk lain diperlakukan
 * sebagai tidak ada, bukan dipaksa menjadi '[object Object]'.
 */
export function headerString(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  if (Buffer.isBuffer(value)) return value.toString('utf8')

  return ''
}

/**
 * Galat yang tidak akan pernah berhasil pada percobaan berikutnya.
 *
 * Pesan cacat, payload yang tidak lolos skema, dan penolakan yang bersifat
 * final dari sistem hulu semuanya masuk kategori ini.
 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof ValidationError) return false
  if (error instanceof AppError) return error.httpStatus >= 500 || error.httpStatus === 429

  // Galat yang tidak kita kenali diperlakukan sebagai sementara. Membuang
  // pesan karena galat tak dikenal lebih berbahaya daripada mencobanya lagi.
  return true
}

export function dispositionFor(
  error: unknown,
  headers: Readonly<Record<string, unknown>>,
): Disposition {
  if (!isRetryable(error)) return { kind: 'dead_letter', reason: 'not_retryable' }

  const attempt = attemptsSoFar(headers)
  const tier = RETRY_TIERS[attempt]

  return tier === undefined
    ? { kind: 'dead_letter', reason: 'exhausted' }
    : { kind: 'retry', tier, attempt: attempt + 1 }
}
