/**
 * Port ke api-gateway dari sisi server panel operator.
 *
 * Seluruh keputusan (jalur mana boleh diteruskan, kapan menyegarkan token,
 * kapan menolak) ada di ops-proxy.ts dan login.ts, terhadap port ini — dan
 * diuji tanpa jaringan. Implementasi `fetch` di bawah sengaja tipis.
 */

export interface GatewayRequest {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  readonly path: string
  readonly body?: unknown
  readonly accessToken?: string
}

export interface GatewayReply {
  readonly status: number
  /** Badan JSON apa adanya: amplop `{ data, error }` dari gateway, atau null. */
  readonly payload: unknown
}

export interface GatewayPort {
  send(request: GatewayRequest): Promise<GatewayReply>
}

export const UNREACHABLE: GatewayReply = {
  status: 503,
  payload: {
    data: null,
    error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Gateway tidak dapat dihubungi.' },
  },
}

export function fetchGateway(baseUrl: string): GatewayPort {
  return {
    async send(request) {
      try {
        const response = await fetch(`${baseUrl}${request.path}`, {
          method: request.method,
          headers: {
            accept: 'application/json',
            ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
            ...(request.accessToken === undefined
              ? {}
              : { authorization: `Bearer ${request.accessToken}` }),
          },
          ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
          cache: 'no-store',
        })
        return { status: response.status, payload: await response.json().catch(() => null) }
      } catch {
        // Alamat gateway tidak pernah ikut ke peramban, bahkan saat gagal.
        return UNREACHABLE
      }
    },
  }
}
