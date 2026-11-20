import type { NextResponse } from 'next/server'
import type { SessionChange } from './ops-proxy'
import type { SessionTokens, TokenPair } from './tokens'

/**
 * Cookie sesi panel operator.
 *
 * Berbeda dari apps/web, KEDUA token disimpan di cookie httpOnly — termasuk
 * access token. Panel ini tidak punya JavaScript yang perlu memegang token:
 * seluruh panggilan ke gateway dibuat rute server aplikasi ini. Token yang
 * tidak pernah sampai ke halaman tidak dapat dicuri skrip di halaman.
 *
 * `sameSite: 'strict'`, bukan `lax` seperti apps/web: panel operator tidak
 * pernah dibuka dari tautan situs lain, jadi tidak ada navigasi lintas situs
 * yang perlu membawa sesi.
 *
 * Nama cookie berbeda dari apps/web supaya kedua aplikasi di domain yang sama
 * (pengembangan lokal) tidak saling menimpa sesi.
 */

export const ACCESS_COOKIE = 'tbe_ops_access'
export const REFRESH_COOKIE = 'tbe_ops_refresh'

/** Satu hari kerja. Operator yang meninggalkan panel semalaman masuk ulang. */
export const REFRESH_MAX_AGE_SECONDS = 60 * 60 * 12

interface CookieReader {
  get(name: string): { readonly value: string } | undefined
}

export function sessionFrom(cookies: CookieReader): SessionTokens {
  return {
    accessToken: cookies.get(ACCESS_COOKIE)?.value,
    refreshToken: cookies.get(REFRESH_COOKIE)?.value,
  }
}

export function applySession(
  response: NextResponse,
  change: SessionChange,
  options: { readonly secure: boolean },
): NextResponse {
  if (change.kind === 'renewed') return withTokens(response, change.tokens, options)
  if (change.kind === 'clear') return withoutSession(response, options)
  return response
}

export function withTokens(
  response: NextResponse,
  tokens: TokenPair,
  options: { readonly secure: boolean },
): NextResponse {
  const base = { httpOnly: true, sameSite: 'strict' as const, secure: options.secure, path: '/' }
  response.cookies.set(ACCESS_COOKIE, tokens.accessToken, { ...base, maxAge: tokens.expiresIn })
  response.cookies.set(REFRESH_COOKIE, tokens.refreshToken, {
    ...base,
    maxAge: REFRESH_MAX_AGE_SECONDS,
  })
  return response
}

export function withoutSession(
  response: NextResponse,
  options: { readonly secure: boolean },
): NextResponse {
  const base = { httpOnly: true, sameSite: 'strict' as const, secure: options.secure, path: '/' }
  response.cookies.set(ACCESS_COOKIE, '', { ...base, maxAge: 0 })
  response.cookies.set(REFRESH_COOKIE, '', { ...base, maxAge: 0 })
  return response
}
