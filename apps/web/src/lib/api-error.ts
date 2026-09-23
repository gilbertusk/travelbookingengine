/**
 * Bentuk galat yang konsisten untuk seluruh aplikasi.
 *
 * Gateway selalu membalas amplop `{ data, error }`, tetapi kegagalan jaringan
 * dan respons yang bukan JSON tidak. Tanpa normalisasi di satu tempat, setiap
 * komponen harus menebak bentuk apa yang sedang dipegangnya, dan tampilan
 * galat berakhir menampilkan "[object Object]".
 */

export type ApiErrorKind = 'network' | 'unauthorized' | 'rate_limited' | 'client' | 'server'

export class ApiError extends Error {
  readonly kind: ApiErrorKind
  readonly status: number
  readonly code: string

  constructor(params: {
    readonly kind: ApiErrorKind
    readonly status: number
    readonly code: string
    readonly message: string
    readonly cause?: unknown
  }) {
    super(params.message, params.cause === undefined ? undefined : { cause: params.cause })
    this.name = 'ApiError'
    this.kind = params.kind
    this.status = params.status
    this.code = params.code
  }
}

export function kindOf(status: number): ApiErrorKind {
  if (status === 401 || status === 403) return 'unauthorized'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'server'
  return 'client'
}

/**
 * Pesan yang layak dibaca pengguna.
 *
 * Pesan 5xx dari server sengaja generik — lihat NFR-15 — jadi yang ditampilkan
 * di sini adalah kalimat kita sendiri, bukan pantulan pesan server yang tidak
 * membantu siapa pun.
 */
export function humanMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Terjadi kesalahan yang tidak terduga.'

  switch (error.kind) {
    case 'network':
      return 'Tidak dapat terhubung. Periksa koneksi internetmu, lalu coba lagi.'
    case 'unauthorized':
      return 'Sesimu sudah berakhir. Masuk kembali untuk melanjutkan.'
    case 'rate_limited':
      return 'Terlalu banyak permintaan dalam waktu singkat. Tunggu sebentar, lalu coba lagi.'
    case 'server':
      return 'Layanan sedang bermasalah. Kami sudah mencatatnya — coba lagi sebentar lagi.'
    case 'client':
      return error.message
  }
}
