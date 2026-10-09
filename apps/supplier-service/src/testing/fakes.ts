import { err, ok, type Result } from '@tbe/shared-kernel'
import type {
  BookingResult,
  HoldResult,
  PriceCheckResult,
  SupplierCode,
  SupplierError,
  SupplierGateway,
  SupplierSearchResult,
} from '@tbe/supplier-adapters'
import {
  CLOSED_CIRCUIT,
  afterFailure,
  afterSuccess,
  decide,
  DEFAULT_CIRCUIT_POLICY,
  type CircuitDecision,
  type CircuitPolicy,
  type CircuitRecord,
  type CircuitState,
  type Transition,
} from '../domain/circuit.js'
import { DEFAULT_RETRY_POLICY } from '../domain/retry-policy.js'
import type {
  CircuitKey,
  CircuitStore,
  CancelReplies,
  ConfirmReplies,
  OutboundRateLimiter,
  RequestLog,
  RequestLogEntry,
  ResilienceDeps,
  SupplierDirectory,
  SupplierEvents,
  SupplierMetrics,
  SupplierSettings,
} from '../application/ports.js'

/**
 * Perkakas uji.
 *
 * Penyimpan pemutus dalam memori memakai FUNGSI TRANSISI YANG SAMA dengan
 * yang dipakai implementasi Redis. Itu disengaja: kalau keduanya menghitung
 * sendiri-sendiri, pengujian akan membuktikan perilaku yang tidak pernah
 * benar-benar berjalan di produksi.
 */

export function memoryCircuitStore(): CircuitStore & {
  readonly records: Map<string, CircuitRecord>
} {
  const records = new Map<string, CircuitRecord>()
  const keyOf = (key: CircuitKey): string => `${key.supplier}:${key.operation}`

  return {
    records,

    async decide(key, policy, nowMs): Promise<CircuitDecision> {
      return await Promise.resolve(decide(records.get(keyOf(key)) ?? CLOSED_CIRCUIT, policy, nowMs))
    },

    async record(key, outcome, policy, nowMs): Promise<Transition> {
      const current = records.get(keyOf(key)) ?? CLOSED_CIRCUIT
      const transition =
        outcome === 'success'
          ? afterSuccess(current, policy, nowMs)
          : afterFailure(current, policy, nowMs)

      records.set(keyOf(key), transition.record)
      return await Promise.resolve(transition)
    },
  }
}

/**
 * Penyimpan yang dibagikan dua instance.
 *
 * Dipakai untuk membuktikan bahwa dua instance berbagi hitungan kegagalan:
 * keduanya menerima objek yang sama, persis seperti keduanya menunjuk ke
 * Redis yang sama.
 */
export function sharedCircuitStore(): CircuitStore {
  return memoryCircuitStore()
}

export function allowAllRateLimiter(): OutboundRateLimiter {
  return {
    async acquire() {
      return await Promise.resolve({ allowed: true, retryAfterMs: 0 })
    },
  }
}

export function denyingRateLimiter(retryAfterMs = 1_000): OutboundRateLimiter {
  return {
    async acquire() {
      return await Promise.resolve({ allowed: false, retryAfterMs })
    },
  }
}

export function recordingLog(): RequestLog & { readonly entries: RequestLogEntry[] } {
  const entries: RequestLogEntry[] = []

  return {
    entries,
    async record(entry) {
      entries.push(entry)
      await Promise.resolve()
    },
  }
}

export interface RecordedEvent {
  readonly type: 'degraded' | 'recovered'
  readonly supplier: SupplierCode
  readonly state?: string
}

export function recordingEvents(): SupplierEvents & { readonly published: RecordedEvent[] } {
  const published: RecordedEvent[] = []

  return {
    published,
    async degraded(supplier, state) {
      published.push({ type: 'degraded', supplier, state })
      await Promise.resolve()
    },
    async recovered(supplier) {
      published.push({ type: 'recovered', supplier })
      await Promise.resolve()
    },
  }
}

export type RecordedReply =
  | ({ readonly type: 'confirmed' } & Parameters<ConfirmReplies['confirmed']>[0])
  | ({ readonly type: 'rejected' } & Parameters<ConfirmReplies['rejected']>[0])
  | ({ readonly type: 'uncertain' } & Parameters<ConfirmReplies['uncertain']>[0])
  | ({ readonly type: 'cancelled' } & Parameters<CancelReplies['cancelled']>[0])
  | ({ readonly type: 'cancel_failed' } & Parameters<CancelReplies['cancelFailed']>[0])

/** Jawaban ke saga yang terekam. `failNext` meniru Kafka yang tidak dapat dihubungi. */
export function recordingReplies(): ConfirmReplies &
  CancelReplies & {
    readonly published: RecordedReply[]
    failNext(): void
  } {
  const published: RecordedReply[] = []
  let failing = false

  async function record(reply: RecordedReply): Promise<void> {
    await Promise.resolve()
    if (failing) {
      failing = false
      throw new Error('kafka tidak dapat dihubungi')
    }
    published.push(reply)
  }

  return {
    published,
    failNext: () => {
      failing = true
    },
    confirmed: async (reply) => {
      await record({ type: 'confirmed', ...reply })
    },
    rejected: async (reply) => {
      await record({ type: 'rejected', ...reply })
    },
    uncertain: async (reply) => {
      await record({ type: 'uncertain', ...reply })
    },
    cancelled: async (reply) => {
      await record({ type: 'cancelled', ...reply })
    },
    cancelFailed: async (reply) => {
      await record({ type: 'cancel_failed', ...reply })
    },
  }
}

export function silentMetrics(): SupplierMetrics & {
  readonly circuitStates: Map<string, CircuitState>
  readonly retries: string[]
} {
  const circuitStates = new Map<string, CircuitState>()
  const retries: string[] = []

  return {
    circuitStates,
    retries,
    observeRequest() {
      // Tidak ada yang perlu dicatat untuk pengujian.
    },
    setCircuitState(supplier, operation, state) {
      circuitStates.set(`${supplier}:${operation}`, state)
    },
    countRetry(supplier, operation, errorKind) {
      retries.push(`${supplier}:${operation}:${errorKind}`)
    },
  }
}

export function memoryDirectory(
  overrides: Partial<Record<SupplierCode, Partial<SupplierSettings>>> = {},
): SupplierDirectory {
  const settings = new Map<SupplierCode, SupplierSettings>()

  const base = (code: SupplierCode): SupplierSettings => ({
    code,
    name: code,
    isActive: true,
    circuit: DEFAULT_CIRCUIT_POLICY,
    retry: DEFAULT_RETRY_POLICY,
    ...overrides[code],
  })

  return {
    async list() {
      return await Promise.resolve([...settings.values()])
    },
    async get(code) {
      return await Promise.resolve(settings.get(code) ?? base(code))
    },
    async update(code, patch) {
      const current = settings.get(code) ?? base(code)
      const next: SupplierSettings = {
        ...current,
        ...(patch.isActive === undefined ? {} : { isActive: patch.isActive }),
        circuit: { ...current.circuit, ...stripUndefined(patch.circuit) },
      }
      settings.set(code, next)
      return await Promise.resolve(next)
    },
  }
}

/** Membuang kunci yang bernilai undefined supaya tidak menimpa nilai yang ada. */
function stripUndefined(patch: object | undefined): Record<string, unknown> {
  if (patch === undefined) return {}

  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined))
}

/** Jam yang dikendalikan pengujian; tidak ada yang menunggu waktu nyata. */
export function fakeClock(startMs = 1_700_000_000_000): {
  now(): number
  advance(ms: number): void
} {
  let current = startMs

  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms
    },
  }
}

/**
 * Tidur yang tidak benar-benar tidur, tetapi memajukan jam.
 *
 * Pengujian backoff yang benar-benar menunggu empat detik adalah pengujian
 * yang akan dimatikan orang.
 */
export function fakeSleeper(clock: { advance(ms: number): void }): {
  sleep(ms: number): Promise<void>
  readonly slept: number[]
} {
  const slept: number[] = []

  return {
    slept,
    async sleep(ms: number) {
      slept.push(ms)
      clock.advance(ms)
      await Promise.resolve()
    },
  }
}

/** Gateway yang menjawab menurut skrip yang ditentukan pengujian. */
export interface ScriptedGateway extends SupplierGateway {
  readonly calls: string[]
}

type Reply<T> = Result<T, SupplierError> | (() => Result<T, SupplierError>)

export interface Script {
  readonly book?: readonly Reply<BookingResult>[]
  readonly lookup?: readonly Reply<BookingResult>[]
  readonly search?: readonly Reply<SupplierSearchResult>[]
  readonly priceCheck?: readonly Reply<PriceCheckResult>[]
  readonly hold?: readonly Reply<HoldResult>[]
  readonly cancel?: readonly Reply<void>[]
}

export function scriptedGateway(supplier: SupplierCode, script: Script): ScriptedGateway {
  const calls: string[] = []
  const cursors = new Map<string, number>()

  function next<T>(
    name: string,
    replies: readonly Reply<T>[] | undefined,
  ): Result<T, SupplierError> {
    calls.push(name)

    if (replies === undefined || replies.length === 0) {
      return err(failure(supplier, name, 'upstream_error'))
    }

    const index = Math.min(cursors.get(name) ?? 0, replies.length - 1)
    cursors.set(name, index + 1)

    const reply = replies[index]
    if (reply === undefined) return err(failure(supplier, name, 'upstream_error'))

    return typeof reply === 'function' ? reply() : reply
  }

  return {
    supplier,
    calls,
    async search() {
      return await Promise.resolve(next('search', script.search))
    },
    async priceCheck() {
      return await Promise.resolve(next('priceCheck', script.priceCheck))
    },
    async hold() {
      return await Promise.resolve(next('hold', script.hold))
    },
    async book() {
      return await Promise.resolve(next('book', script.book))
    },
    async cancel() {
      return await Promise.resolve(next('cancel', script.cancel))
    },
    async getBooking() {
      return await Promise.resolve(next('getBooking', script.lookup))
    },
    async findBookingByIdempotencyKey() {
      return await Promise.resolve(next('findByKey', script.lookup))
    },
  }
}

export function failure(
  supplier: SupplierCode,
  operation: string,
  kind: SupplierError['kind'],
): SupplierError {
  const base = { supplier, operation } as const

  switch (kind) {
    case 'timeout':
      return { ...base, kind, timeoutMs: 1_000 }
    case 'unavailable':
    case 'rate_limited':
      return { ...base, kind }
    case 'invalid_response':
      return { ...base, kind, reason: 'bukan JSON' }
    case 'not_found':
      return { ...base, kind, what: 'booking' }
    case 'upstream_error':
      return { ...base, kind, status: 500 }
    default:
      return { ...base, kind }
  }
}

export function booking(supplier: SupplierCode, reference: string): BookingResult {
  return {
    supplier,
    bookingReference: reference,
    status: 'CONFIRMED',
    total: { amountMinor: 500_000, currency: 'IDR' },
    checkIn: '2026-11-10',
    checkOut: '2026-11-12',
  }
}

export interface Harness {
  readonly deps: ResilienceDeps
  readonly gateway: ScriptedGateway
  readonly clock: ReturnType<typeof fakeClock>
  readonly sleeper: ReturnType<typeof fakeSleeper>
  readonly log: ReturnType<typeof recordingLog>
  readonly events: ReturnType<typeof recordingEvents>
  readonly metrics: ReturnType<typeof silentMetrics>
  readonly circuits: CircuitStore
}

export function harness(
  options: {
    readonly supplier?: SupplierCode
    readonly script?: Script
    readonly circuits?: CircuitStore
    readonly rateLimiter?: OutboundRateLimiter
    readonly directory?: SupplierDirectory
    readonly circuitPolicy?: CircuitPolicy
    /** Tetap, supaya jitter dapat diperiksa. */
    readonly random?: () => number
  } = {},
): Harness {
  const supplier = options.supplier ?? 'SKY'
  const gateway = scriptedGateway(supplier, options.script ?? {})
  const clock = fakeClock()
  const sleeper = fakeSleeper(clock)
  const log = recordingLog()
  const events = recordingEvents()
  const metrics = silentMetrics()
  const circuits = options.circuits ?? memoryCircuitStore()

  const directory =
    options.directory ??
    memoryDirectory(
      options.circuitPolicy === undefined ? {} : { [supplier]: { circuit: options.circuitPolicy } },
    )

  return {
    gateway,
    clock,
    sleeper,
    log,
    events,
    metrics,
    circuits,
    deps: {
      registry: { get: () => gateway, all: () => [gateway] },
      circuits,
      rateLimiter: options.rateLimiter ?? allowAllRateLimiter(),
      requestLog: log,
      events,
      metrics,
      directory,
      clock,
      sleeper,
      random: options.random ?? (() => 0.5),
    },
  }
}

export { ok, err }
