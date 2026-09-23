import { publicConfig } from '@/config'
import { getAccessToken, setAccessToken } from './access-token'
import { ApiError, kindOf } from './api-error'

/**
 * Satu-satunya jalan keluar ke jaringan.
 *
 * Tidak ada komponen yang memanggil `fetch` sendiri — CONVENTIONS.md bagian 13.
 * Yang dipusatkan di sini ada empat hal yang selalu salah kalau ditulis ulang
 * di banyak tempat: alamat dasar, penyisipan token, penanganan 401, dan
 * penerjemahan kegagalan menjadi satu bentuk galat.
 */

interface Envelope<T> {
  readonly data: T | null
  readonly error: { readonly code: string; readonly message: string } | null
}

export interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  readonly body?: unknown
  readonly signal?: AbortSignal
  /** Dipakai internal untuk mencegah percobaan refresh berulang. */
  readonly retryOnUnauthorized?: boolean
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await send(path, options)

  if (response.status === 401 && (options.retryOnUnauthorized ?? true)) {
    // Sekali saja. Refresh yang gagal lalu dicoba lagi hanya menghasilkan
    // rantai permintaan yang tidak berujung sementara pengguna menatap
    // layar memuat.
    const refreshed = await refreshAccessToken()
    if (!refreshed) throw sessionExpired()

    return await apiRequest<T>(path, { ...options, retryOnUnauthorized: false })
  }

  return await unwrap<T>(response)
}

async function send(path: string, options: RequestOptions): Promise<Response> {
  const token = getAccessToken()

  const headers: Record<string, string> = { accept: 'application/json' }
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  if (token !== undefined) headers.authorization = `Bearer ${token}`

  try {
    return await fetch(`${publicConfig.apiUrl}${path}`, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  } catch (cause) {
    throw new ApiError({
      kind: 'network',
      status: 0,
      code: 'NETWORK_ERROR',
      message: 'Permintaan tidak sampai ke server.',
      cause,
    })
  }
}

async function unwrap<T>(response: Response): Promise<T> {
  const envelope = await readEnvelope<T>(response)

  if (!response.ok) {
    throw new ApiError({
      kind: kindOf(response.status),
      status: response.status,
      code: envelope?.error?.code ?? 'UNKNOWN',
      message:
        envelope?.error?.message ?? `Permintaan gagal dengan status ${String(response.status)}.`,
    })
  }

  if (envelope?.data == null) {
    throw new ApiError({
      kind: 'server',
      status: response.status,
      code: 'MALFORMED_RESPONSE',
      message: 'Respons server tidak dalam bentuk yang diharapkan.',
    })
  }

  return envelope.data
}

/**
 * Badan respons dibaca sebagai teks lebih dulu.
 *
 * Respons yang bukan JSON — halaman galat proksi, misalnya — akan membuat
 * `response.json()` melempar, dan galat penguraian itu menggantikan status
 * HTTP aslinya. Yang tersisa untuk pengguna adalah "Unexpected token <",
 * bukan "layanan sedang bermasalah".
 */
async function readEnvelope<T>(response: Response): Promise<Envelope<T> | undefined> {
  const text = await response.text()
  if (text.length === 0) return undefined

  try {
    return JSON.parse(text) as Envelope<T>
  } catch {
    return undefined
  }
}

/**
 * Refresh lewat rute Next, bukan langsung ke gateway.
 *
 * Refresh token ada di cookie httpOnly yang tidak dapat dibaca JavaScript.
 * Rute inilah yang memegangnya, menukarnya di gateway, dan mengembalikan
 * access token baru ke memori halaman.
 */
export async function refreshAccessToken(): Promise<boolean> {
  try {
    const response = await fetch('/api/auth/refresh', { method: 'POST' })
    if (!response.ok) {
      setAccessToken(undefined)
      return false
    }

    const body = (await response.json()) as { accessToken?: unknown }
    if (typeof body.accessToken !== 'string') {
      setAccessToken(undefined)
      return false
    }

    setAccessToken(body.accessToken)
    return true
  } catch {
    setAccessToken(undefined)
    return false
  }
}

function sessionExpired(): ApiError {
  return new ApiError({
    kind: 'unauthorized',
    status: 401,
    code: 'SESSION_EXPIRED',
    message: 'Sesi berakhir.',
  })
}
