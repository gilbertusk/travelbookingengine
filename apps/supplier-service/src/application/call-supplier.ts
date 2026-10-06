import { err, ok, type Result } from '@tbe/shared-kernel'
import type { SupplierCode, SupplierError } from '@tbe/supplier-adapters'
import { DEFAULT_CIRCUIT_POLICY, observedState } from '../domain/circuit.js'
import { DEFAULT_RETRY_POLICY, decideRetry } from '../domain/retry-policy.js'
import { redact } from '../domain/redaction.js'
import { countsAsCircuitFailure, type ResilienceDeps } from './ports.js'

/**
 * Satu panggilan ke supplier, dengan seluruh lapisan ketahanan di sekelilingnya.
 *
 * Urutannya tetap dan berarti:
 *
 * 1. **Pemutus sirkuit** — kalau supplier sudah jelas tumbang, jangan menyentuh
 *    jaringan sama sekali. Ini yang membuat kegagalan satu supplier tidak
 *    menurunkan latensi alur pencarian (NFR-03): panggilan ditolak dalam
 *    mikrodetik, bukan setelah menunggu batas waktu.
 * 2. **Pembatas laju keluar** — melindungi supplier dari dibanjiri kita sendiri.
 * 3. **Panggilan** — lewat adapter Step 10.
 * 4. **Pencatatan** — setiap percobaan, bukan hanya yang terakhir.
 * 5. **Pemutus diperbarui**, dan perubahan keadaannya diterbitkan ke Kafka.
 * 6. **Percobaan ulang**, bila jenis kegagalannya memang layak diulang.
 *
 * Operasi yang MENGUBAH keadaan tidak boleh lewat sini begitu saja. Lihat
 * [confirmBooking] di confirm-booking.ts.
 */

export interface CallParams<T> {
  readonly supplier: SupplierCode
  readonly operation: string
  /** Dijalankan sekali per percobaan. */
  readonly run: () => Promise<Result<T, SupplierError>>
  /** Ikut dicatat setelah diredaksi. */
  readonly requestPayload?: unknown
  readonly idempotencyKey?: string | undefined
  readonly correlationId?: string | undefined
  /** Menonaktifkan percobaan ulang, untuk operasi yang mengubah keadaan. */
  readonly noRetry?: boolean
  /**
   * Operasi yang mengubah keadaan di supplier dan TIDAK idempoten (hold).
   * Hanya dicoba ulang bila permintaannya pasti belum dikerjakan: koneksi
   * tidak pernah terbentuk, atau supplier menolak karena laju. Batas waktu
   * dan koneksi yang putus setelah terbentuk tidak dicoba ulang — efeknya
   * mungkin sudah terjadi, dan percobaan kedua menggandakannya (Step 20).
   */
  readonly mutating?: boolean
}

/** Kegagalan yang memastikan permintaan belum dikerjakan supplier. */
const UNDELIVERED: ReadonlySet<SupplierError['kind']> = new Set(['unavailable', 'rate_limited'])

export async function callSupplier<T>(
  deps: ResilienceDeps,
  params: CallParams<T>,
): Promise<Result<T, SupplierError>> {
  const settings = await deps.directory.get(params.supplier)

  if (settings !== undefined && !settings.isActive) {
    // Supplier yang dinonaktifkan operator tidak dihubungi sama sekali, dan
    // itu bukan kegagalan yang perlu dicoba ulang.
    return err(unavailable(params))
  }

  const circuitPolicy = settings?.circuit ?? DEFAULT_CIRCUIT_POLICY
  const retryPolicy = settings?.retry ?? DEFAULT_RETRY_POLICY

  let attempt = 1

  for (;;) {
    const gate = await passGate(deps, params, circuitPolicy)
    if (!gate.ok) return gate

    const result = await attemptOnce(deps, params, attempt, circuitPolicy)
    if (result.ok) return result

    if (params.noRetry === true) return result
    if (params.mutating === true && !UNDELIVERED.has(result.error.kind)) return result

    const decision = decideRetry(result.error, attempt, retryPolicy, deps.random)
    if (!decision.retry) return result

    deps.metrics.countRetry(params.supplier, params.operation, result.error.kind)
    await deps.sleeper.sleep(decision.delayMs)
    attempt = decision.nextAttempt
  }
}

/**
 * Pemutus dan pembatas laju, sebelum jaringan disentuh.
 *
 * Keduanya menolak dengan jenis kegagalan yang berbeda dengan sengaja:
 * pemutus terbuka menjadi `unavailable`, kuota habis menjadi `rate_limited`.
 * Pemanggil di atas kita membedakan keduanya — yang satu berarti supplier
 * bermasalah, yang lain berarti kita yang terlalu cepat.
 */
async function passGate<T>(
  deps: ResilienceDeps,
  params: CallParams<T>,
  policy: typeof DEFAULT_CIRCUIT_POLICY,
): Promise<Result<void, SupplierError>> {
  const key = { supplier: params.supplier, operation: params.operation }
  const now = deps.clock.now()

  const decision = await deps.circuits.decide(key, policy, now)
  deps.metrics.setCircuitState(params.supplier, params.operation, decision.state)

  if (!decision.allowed) {
    return err({
      supplier: params.supplier,
      operation: params.operation,
      kind: 'unavailable',
      retryAfterSeconds: Math.ceil(decision.retryAfterMs / 1_000),
    })
  }

  const verdict = await deps.rateLimiter.acquire(params.supplier, now)
  if (!verdict.allowed) {
    return err({
      supplier: params.supplier,
      operation: params.operation,
      kind: 'rate_limited',
      retryAfterSeconds: Math.ceil(verdict.retryAfterMs / 1_000),
    })
  }

  return ok(undefined)
}

async function attemptOnce<T>(
  deps: ResilienceDeps,
  params: CallParams<T>,
  attempt: number,
  policy: typeof DEFAULT_CIRCUIT_POLICY,
): Promise<Result<T, SupplierError>> {
  const startedAt = deps.clock.now()
  const result = await params.run()
  const latencyMs = Math.max(deps.clock.now() - startedAt, 0)

  const outcome = result.ok ? 'success' : 'failure'
  const errorKind = result.ok ? undefined : result.error.kind

  deps.metrics.observeRequest({
    supplier: params.supplier,
    operation: params.operation,
    outcome: errorKind ?? 'success',
    seconds: latencyMs / 1_000,
  })

  await deps.requestLog.record({
    supplier: params.supplier,
    operation: params.operation,
    outcome,
    errorKind,
    attemptNumber: attempt,
    latencyMs,
    requestPayload: redact(params.requestPayload),
    responsePayload: result.ok ? null : { kind: result.error.kind },
    idempotencyKey: params.idempotencyKey,
    correlationId: params.correlationId,
  })

  await updateCircuit(deps, params, result, policy)

  return result
}

/**
 * Memperbarui pemutus dan menerbitkan perubahan keadaannya.
 *
 * Peristiwa hanya terbit ketika keadaan benar-benar berubah. Menerbitkan pada
 * setiap kegagalan akan membanjiri topik dengan ribuan pesan yang mengatakan
 * hal yang sama, dan yang menyaringnya harus menulis logika deduplikasi yang
 * seharusnya ada di sini.
 */
async function updateCircuit<T>(
  deps: ResilienceDeps,
  params: CallParams<T>,
  result: Result<T, SupplierError>,
  policy: typeof DEFAULT_CIRCUIT_POLICY,
): Promise<void> {
  if (!result.ok && !countsAsCircuitFailure(result.error)) {
    // Kamar habis bukan kegagalan supplier. Menghitungnya akan membuka
    // pemutus tepat saat permintaan sedang tinggi.
    return
  }

  const key = { supplier: params.supplier, operation: params.operation }
  const now = deps.clock.now()

  const transition = await deps.circuits.record(key, result.ok ? 'success' : 'failure', policy, now)

  const state = observedState(transition.record, policy, now)
  deps.metrics.setCircuitState(params.supplier, params.operation, state)

  if (transition.changedTo === undefined) return

  if (transition.changedTo === 'closed') {
    await deps.events.recovered(params.supplier)
    return
  }

  await deps.events.degraded(
    params.supplier,
    transition.changedTo,
    result.ok ? 'percobaan pemulihan' : result.error.kind,
  )
}

/**
 * Supplier yang dinonaktifkan operator.
 *
 * Dilaporkan sebagai `unavailable` supaya fan-out pencarian pada Step 13
 * memperlakukannya sama seperti supplier yang sedang tumbang: dilewati, dan
 * hasilnya ditandai parsial. Tidak ada percobaan ulang di sini — kami kembali
 * sebelum gelungnya dimulai.
 */
function unavailable<T>(params: CallParams<T>): SupplierError {
  return { supplier: params.supplier, operation: params.operation, kind: 'unavailable' }
}
