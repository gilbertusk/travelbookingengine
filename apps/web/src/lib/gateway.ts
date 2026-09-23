import { NextResponse } from 'next/server'
import { serverConfig } from '@/config'

/**
 * Pemanggilan gateway dari sisi server.
 *
 * Berbeda dari [apiRequest] yang berjalan di peramban: di sini tidak ada
 * access token untuk disisipkan dan tidak ada 401 untuk ditangani dengan
 * refresh — rute inilah yang justru melakukan refresh itu.
 */

export interface GatewayResult<T> {
  readonly ok: boolean
  readonly status: number
  readonly data: T | null
  readonly error: { readonly code: string; readonly message: string } | null
}

export async function callGateway<T>(
  path: string,
  init: { readonly method: 'POST' | 'GET'; readonly body?: unknown },
): Promise<GatewayResult<T>> {
  try {
    const response = await fetch(`${serverConfig().apiUrl}${path}`, {
      method: init.method,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      cache: 'no-store',
    })

    const payload = (await response.json().catch(() => null)) as GatewayResult<T> | null

    return {
      ok: response.ok,
      status: response.status,
      data: payload?.data ?? null,
      error: payload?.error ?? null,
    }
  } catch {
    // Alamat gateway tidak pernah ikut ke peramban, bahkan saat gagal.
    return {
      ok: false,
      status: 503,
      data: null,
      error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Layanan sedang tidak dapat dihubungi.' },
    }
  }
}

export function gatewayErrorResponse(result: GatewayResult<unknown>): NextResponse {
  return NextResponse.json(
    {
      error: {
        code: result.error?.code ?? 'UNKNOWN',
        message: result.error?.message ?? 'Permintaan gagal.',
      },
    },
    { status: result.status },
  )
}
