import { Readable } from 'node:stream'
import { createLogger, type Logger } from '@tbe/shared-kernel'
import type { Express } from 'express'
import type {
  GatewayDeps,
  RateLimiter,
  TokenVerifier,
  Upstream,
  UpstreamOutcome,
  UpstreamRequest,
} from '../application/ports.js'
import { createGatewayApp } from '../composition/app.js'
import { createMemoryRateLimiter, type RateLimitPolicy } from '../infrastructure/rate-limiters.js'
import type { RateLimitClass } from '../domain/routes.js'

/** Perkakas uji. Tidak ikut ter-build. */

export function silentLogger(): Logger {
  return createLogger({
    serviceName: 'gateway-test',
    level: 'silent',
    destination: {
      write(): void {
        // keluaran log tidak diuji di sini
      },
    },
  })
}

export interface RecordedUpstreamCall {
  readonly request: UpstreamRequest
  readonly headers: Readonly<Record<string, string | string[]>>
}

export interface FakeUpstream extends Upstream {
  readonly calls: readonly RecordedUpstreamCall[]
  respondWith(outcome: UpstreamOutcome): void
  setReachable(reachable: boolean): void
}

export function createFakeUpstream(): FakeUpstream {
  const calls: RecordedUpstreamCall[] = []
  let reachable = true
  let next: UpstreamOutcome = {
    kind: 'response',
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: Readable.from(['{"data":{"ok":true},"error":null}']),
  }

  return {
    calls,

    respondWith(outcome) {
      next = outcome
    },

    setReachable(value) {
      reachable = value
    },

    send: async (request) => {
      await Promise.resolve()
      calls.push({ request, headers: request.headers })

      // Badan respons hanya dapat dibaca sekali, jadi aliran baru dibuat untuk
      // setiap panggilan; memakai ulang yang sama membuat permintaan kedua
      // menerima respons kosong.
      return next.kind === 'response'
        ? { ...next, body: Readable.from([await readAll(next.body)]) }
        : next
    },

    probe: async () => {
      await Promise.resolve()
      return reachable
    },
  }
}

async function readAll(stream: Readable): Promise<string> {
  const chunks: string[] = []
  for await (const chunk of stream) chunks.push(String(chunk))
  return chunks.join('')
}

export function jsonResponse(statusCode: number, body: unknown): UpstreamOutcome {
  return {
    kind: 'response',
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: Readable.from([JSON.stringify(body)]),
  }
}

export function createFakeVerifier(
  valid: Readonly<Record<string, { userId: string; email: string }>> = {},
): TokenVerifier {
  return {
    verify: async (token) => {
      await Promise.resolve()
      return valid[token]
    },
  }
}

export function createPermissiveLimiter(): RateLimiter {
  return {
    consume: async () => {
      await Promise.resolve()
      return { allowed: true, limit: 1_000, remaining: 999, resetAfterSeconds: 60 }
    },
  }
}

export interface GatewayHarness {
  readonly app: Express
  readonly upstream: FakeUpstream
  readonly deps: GatewayDeps
}

export const VALID_TOKEN = 'token-budi'
export const BUDI = { userId: 'user-001', email: 'budi@example.com' }

export function createGatewayHarness(overrides: Partial<GatewayDeps> = {}): GatewayHarness {
  const upstream = createFakeUpstream()

  const deps: GatewayDeps = {
    verifier: createFakeVerifier({ [VALID_TOKEN]: BUDI }),
    limiter: createPermissiveLimiter(),
    upstream,
    ...overrides,
  }

  const { app } = createGatewayApp({
    deps,
    logger: silentLogger(),
    serviceName: 'gateway-test',
  })

  return { app, upstream, deps }
}

export function tightLimiter(points: number): RateLimiter {
  const policy: RateLimitPolicy = { points, durationSeconds: 60 }
  const policies: Record<RateLimitClass, RateLimitPolicy> = {
    public: policy,
    authenticated: policy,
    search: policy,
    sensitive: policy,
  }

  return createMemoryRateLimiter(policies)
}
