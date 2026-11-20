import type { GatewayPort, GatewayReply } from './gateway'
import { dataOf, tokenPairSchema, type SessionTokens, type TokenPair } from './tokens'

/**
 * Penerusan permintaan panel ke `/ops/*` di gateway (Step 27).
 *
 * Peramban memanggil `/api/ops/<sisa>` di aplikasi ini; rute server
 * meneruskannya ke `<gateway>/ops/<sisa>` dengan access token dari cookie
 * httpOnly. Token tidak pernah sampai ke JavaScript halaman, dan peramban
 * tidak pernah tahu alamat gateway.
 *
 * Jalur dibatasi KE `/ops/` saja. Tanpa batas ini rute ini menjadi proksi
 * terbuka yang menempelkan token operator ke jalur gateway mana pun yang
 * diminta peramban — termasuk `../auth/...` bila segmen tidak diperiksa.
 */

export const OPS_METHODS = ['GET', 'POST', 'PATCH', 'DELETE'] as const
export type OpsMethod = (typeof OPS_METHODS)[number]

export interface ProxyInput {
  readonly method: OpsMethod
  readonly segments: readonly string[]
  /** `?a=b` atau '' — diteruskan apa adanya. */
  readonly search: string
  readonly body?: unknown
  readonly tokens: SessionTokens
}

export type SessionChange =
  | { readonly kind: 'keep' }
  | { readonly kind: 'renewed'; readonly tokens: TokenPair }
  | { readonly kind: 'clear' }

export interface ProxyResult extends GatewayReply {
  readonly session: SessionChange
}

/** Segmen yang aman: huruf, angka, tanda hubung, garis bawah, titik — bukan `.` atau `..`. */
const SAFE_SEGMENT = /^[A-Za-z0-9_.-]+$/

export function opsPath(segments: readonly string[]): string | undefined {
  const isSafe =
    segments.length > 0 &&
    segments.every((segment) => SAFE_SEGMENT.test(segment) && segment !== '.' && segment !== '..')
  return isSafe ? `/ops/${segments.join('/')}` : undefined
}

export async function forwardToOps(gateway: GatewayPort, input: ProxyInput): Promise<ProxyResult> {
  const path = opsPath(input.segments)
  if (path === undefined) return refusal(400, 'INVALID_PATH', 'Jalur tidak sah.')
  if (input.tokens.accessToken === undefined && input.tokens.refreshToken === undefined) {
    return refusal(401, 'SESSION_REQUIRED', 'Masuk sebagai operator lebih dulu.')
  }

  const send = async (accessToken: string | undefined) =>
    await gateway.send({
      method: input.method,
      path: `${path}${input.search}`,
      ...(input.body === undefined ? {} : { body: input.body }),
      ...(accessToken === undefined ? {} : { accessToken }),
    })

  const first = await send(input.tokens.accessToken)
  if (first.status !== 401) return { ...first, session: { kind: 'keep' } }

  // Access token kedaluwarsa (atau tidak ada): segarkan SEKALI, lalu ulangi.
  const renewed = await refresh(gateway, input.tokens.refreshToken)
  if (renewed === undefined) return { ...first, session: { kind: 'clear' } }

  const second = await send(renewed.accessToken)
  return { ...second, session: { kind: 'renewed', tokens: renewed } }
}

export async function refresh(
  gateway: GatewayPort,
  refreshToken: string | undefined,
): Promise<TokenPair | undefined> {
  if (refreshToken === undefined) return undefined
  const reply = await gateway.send({
    method: 'POST',
    path: '/auth/refresh',
    body: { refreshToken },
  })
  if (reply.status !== 200) return undefined
  const parsed = tokenPairSchema.safeParse(dataOf(reply.payload))
  return parsed.success ? parsed.data : undefined
}

/**
 * Permintaan yang mengubah sesuatu hanya diterima dari asal yang sama.
 *
 * Cookie sesi `sameSite: strict` sudah menutup sebagian besar CSRF; ini
 * lapisan kedua untuk peramban lama dan untuk subdomain yang berbagi situs.
 * Tanpa header Origin sama sekali (bukan peramban) juga ditolak — panel ini
 * hanya dipakai lewat peramban.
 */
export function isSameOrigin(
  method: OpsMethod,
  origin: string | null,
  requestUrl: string,
): boolean {
  if (method === 'GET') return true
  if (origin === null) return false
  return origin === new URL(requestUrl).origin
}

function refusal(status: number, code: string, message: string): ProxyResult {
  return { status, payload: { data: null, error: { code, message } }, session: { kind: 'keep' } }
}
