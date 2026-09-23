import { apiRequest } from '@/lib/api-client'
import { setAccessToken } from '@/lib/access-token'
import { ApiError } from '@/lib/api-error'
import type { LoginInput, RegisterInput, Session, User } from './types'

/**
 * Panggilan jaringan fitur autentikasi.
 *
 * Masuk, daftar, dan keluar TIDAK memanggil gateway langsung. Ketiganya lewat
 * rute Next di `/api/auth/*`, karena hanya server yang boleh memegang refresh
 * token: rute itulah yang menyimpannya ke cookie httpOnly, dan cookie httpOnly
 * adalah satu-satunya tempat penyimpanan yang tidak dapat dibaca skrip.
 *
 * Sisanya — profil, dan seluruh fitur lain nanti — memanggil gateway langsung
 * lewat [apiRequest] dengan access token dari memori.
 */

async function postToBff(path: string, body: unknown): Promise<Session> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  const payload = (await response.json().catch(() => null)) as {
    user?: User
    accessToken?: string
    error?: { code?: string; message?: string }
  } | null

  if (!response.ok || payload?.accessToken === undefined || payload.user === undefined) {
    throw new ApiError({
      kind: response.status === 401 ? 'unauthorized' : 'client',
      status: response.status,
      code: payload?.error?.code ?? 'AUTH_FAILED',
      message: payload?.error?.message ?? 'Tidak dapat memproses permintaan.',
    })
  }

  setAccessToken(payload.accessToken)

  return { user: payload.user, accessToken: payload.accessToken }
}

export async function login(input: LoginInput): Promise<Session> {
  return await postToBff('/api/auth/login', input)
}

export async function register(input: RegisterInput): Promise<Session> {
  return await postToBff('/api/auth/register', input)
}

export async function logout(): Promise<void> {
  try {
    await fetch('/api/auth/logout', { method: 'POST' })
  } finally {
    // Token dibuang apa pun hasil permintaannya. Keluar yang gagal di server
    // tetapi menyisakan token di peramban adalah keadaan terburuk: pengguna
    // yakin sudah keluar, padahal belum.
    setAccessToken(undefined)
  }
}

export async function fetchProfile(): Promise<User> {
  return await apiRequest<User>('/auth/me')
}
