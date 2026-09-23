import type { Readable } from 'node:stream'
import type { RateLimitClass, ServiceName } from '../domain/routes.js'

export interface VerifiedIdentity {
  readonly userId: string
  readonly email: string
}

export interface TokenVerifier {
  verify(token: string): Promise<VerifiedIdentity | undefined>
}

export interface RateLimitDecision {
  readonly allowed: boolean
  readonly limit: number
  readonly remaining: number
  readonly resetAfterSeconds: number
}

export interface RateLimiter {
  consume(limitClass: RateLimitClass, key: string): Promise<RateLimitDecision>
}

export interface UpstreamRequest {
  readonly service: ServiceName
  readonly method: string
  readonly path: string
  readonly headers: Readonly<Record<string, string | string[]>>
  readonly body: Readable | undefined
  readonly timeoutMs: number
}

export type UpstreamOutcome =
  | {
      readonly kind: 'response'
      readonly statusCode: number
      readonly headers: Readonly<Record<string, string | string[] | undefined>>
      readonly body: Readable
    }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'unreachable' }

export interface Upstream {
  send(request: UpstreamRequest): Promise<UpstreamOutcome>
  /** Dipakai health check; mengembalikan true bila service membalas. */
  probe(service: ServiceName): Promise<boolean>
}

export interface GatewayDeps {
  readonly verifier: TokenVerifier
  readonly limiter: RateLimiter
  readonly upstream: Upstream
}
