import type { Logger } from 'pino'

/**
 * Startup berurutan dan graceful shutdown.
 *
 * Urutan penutupan adalah kebalikan urutan pembukaan, dan itu bukan kerapian
 * belaka: consumer pesan harus berhenti sebelum koneksi databasenya ditutup,
 * kalau tidak pesan yang sedang diproses gagal di tengah dan offset-nya
 * terlanjur ter-commit. Pada Step 19 kesalahan seperti itu berarti saga
 * terpotong dan pemesanan menggantung — persis yang dilarang NFR-06.
 */

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 15_000

export interface ManagedResource {
  readonly name: string
  readonly start?: () => Promise<void>
  readonly stop: () => Promise<void>
}

export interface AppOptions {
  readonly serviceName: string
  readonly logger: Logger
  readonly resources: readonly ManagedResource[]
  readonly shutdownTimeoutMs?: number | undefined
  /** Dimatikan pada pengujian agar handler sinyal tidak menumpuk antar test. */
  readonly handleSignals?: boolean | undefined
}

export interface ManagedApp {
  start(): Promise<void>
  stop(reason: string): Promise<void>
}

export function createApp(options: AppOptions): ManagedApp {
  const { logger, resources } = options
  const timeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
  const started: ManagedResource[] = []
  let stopping: Promise<void> | undefined

  async function stopStarted(reason: string): Promise<void> {
    for (const resource of [...started].reverse()) {
      try {
        await resource.stop()
        logger.info({ resource: resource.name }, 'sumber daya ditutup')
      } catch (error) {
        // Satu sumber daya yang gagal ditutup tidak boleh menghentikan
        // penutupan sisanya — yang lain bisa saja memegang koneksi terbuka.
        logger.error({ err: error, resource: resource.name }, 'gagal menutup sumber daya')
      }
    }
    started.length = 0
    logger.info({ reason }, 'penutupan selesai')
  }

  async function start(): Promise<void> {
    for (const resource of resources) {
      try {
        await resource.start?.()
        started.push(resource)
        logger.info({ resource: resource.name }, 'sumber daya siap')
      } catch (error) {
        logger.error({ err: error, resource: resource.name }, 'gagal menyalakan sumber daya')
        await stopStarted('startup gagal')
        throw error
      }
    }

    if (options.handleSignals !== false) registerSignalHandlers(stop, logger)
    logger.info({ service: options.serviceName }, 'service siap')
  }

  async function stop(reason: string): Promise<void> {
    stopping ??= withTimeout(stopStarted(reason), timeoutMs, logger)
    await stopping
  }

  return { start, stop }
}

async function withTimeout(
  promise: Promise<void>,
  timeoutMs: number,
  logger: Logger,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined

  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      logger.error({ timeoutMs }, 'penutupan melewati batas waktu, dipaksa selesai')
      resolve()
    }, timeoutMs)
  })

  try {
    await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function registerSignalHandlers(stop: (reason: string) => Promise<void>, logger: Logger): void {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      logger.info({ signal }, 'sinyal penutupan diterima')
      void stop(signal).then(
        () => process.exit(0),
        (error: unknown) => {
          logger.error({ err: error }, 'penutupan berakhir dengan galat')
          process.exit(1)
        },
      )
    })
  }
}
