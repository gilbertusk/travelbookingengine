import { cookies } from 'next/headers'
import { serverConfig } from '@/config'

/**
 * Cookie refresh token.
 *
 * Hanya dipakai di rute server (`app/api/auth/*`) dan middleware. Refresh
 * token tidak pernah sampai ke JavaScript halaman: ia masuk sebagai cookie
 * `httpOnly`, dan satu-satunya yang dapat menukarnya adalah server.
 *
 * Kombinasi yang dipilih dan alasannya:
 * - `httpOnly` — skrip apa pun yang berhasil masuk ke halaman tidak dapat
 *   membacanya, sehingga satu celah XSS tidak otomatis menjadi pencurian sesi
 * - `sameSite: 'lax'` — cookie tidak ikut terkirim pada permintaan lintas
 *   situs, yang menutup CSRF untuk rute POST ini
 * - `secure` di luar pengembangan — cookie tidak pernah melintas HTTP polos
 */

export const REFRESH_COOKIE = 'tbe_refresh'

const THIRTY_DAYS_SECONDS = 60 * 60 * 24 * 30

export async function setRefreshCookie(token: string): Promise<void> {
  const store = await cookies()

  store.set(REFRESH_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: serverConfig().secureCookies,
    path: '/',
    maxAge: THIRTY_DAYS_SECONDS,
  })
}

export async function readRefreshCookie(): Promise<string | undefined> {
  const store = await cookies()

  return store.get(REFRESH_COOKIE)?.value
}

export async function clearRefreshCookie(): Promise<void> {
  const store = await cookies()

  store.set(REFRESH_COOKIE, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: serverConfig().secureCookies,
    path: '/',
    maxAge: 0,
  })
}
