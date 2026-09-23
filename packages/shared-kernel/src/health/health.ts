import { Router } from 'express'
import type { Logger } from 'pino'

/**
 * Liveness dan readiness dibedakan dengan sengaja.
 *
 * Liveness menjawab "proses ini masih hidup" — kalau gagal, orkestrator
 * membunuh dan menyalakan ulang. Readiness menjawab "siap menerima trafik" —
 * kalau gagal, trafik dialihkan tetapi proses dibiarkan hidup.
 *
 * Menyamakan keduanya adalah kesalahan yang mahal: database yang sedang
 * terputus sementara akan membuat seluruh replika dibunuh berulang kali,
 * padahal menunggu beberapa detik sudah cukup.
 */

export interface HealthCheck {
  readonly name: string
  check(): Promise<boolean>
}

export interface DependencyStatus {
  readonly name: string
  readonly healthy: boolean
}

const CHECK_TIMEOUT_MS = 3_000

export function createHealthRouter(checks: readonly HealthCheck[], logger: Logger): Router {
  const router = Router()

  router.get('/health/live', (_req, res) => {
    res.status(200).json({ data: { status: 'alive' }, error: null })
  })

  router.get('/health/ready', (_req, res) => {
    void runChecks(checks, logger).then((dependencies) => {
      const healthy = dependencies.every((dependency) => dependency.healthy)
      res.status(healthy ? 200 : 503).json({
        data: { status: healthy ? 'ready' : 'not_ready', dependencies },
        error: null,
      })
    })
  })

  return router
}

export async function runChecks(
  checks: readonly HealthCheck[],
  logger: Logger,
): Promise<readonly DependencyStatus[]> {
  return await Promise.all(checks.map(async (check) => await runOne(check, logger)))
}

async function runOne(check: HealthCheck, logger: Logger): Promise<DependencyStatus> {
  try {
    const healthy = await withTimeout(check.check(), CHECK_TIMEOUT_MS)
    return { name: check.name, healthy }
  } catch (error) {
    // Pemeriksaan yang melempar berarti dependensinya tidak sehat. Ditelan di
    // sini karena itu memang jawabannya, tetapi tetap dicatat — CONVENTIONS.md
    // bagian 5 melarang menelan error tanpa jejak.
    logger.warn({ err: error, dependency: check.name }, 'pemeriksaan kesiapan gagal')
    return { name: check.name, healthy: false }
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`pemeriksaan melewati ${String(timeoutMs)}ms`))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
