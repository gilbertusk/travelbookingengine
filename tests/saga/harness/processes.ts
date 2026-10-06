import { spawn, type ChildProcess } from 'node:child_process'
import { request } from 'undici'
import { eventually } from './waits.js'

/**
 * Service aplikasi sebagai PROSES OS sungguhan — `node dist/index.js`, sama
 * dengan `pnpm start`.
 *
 * Alternatif yang ditolak: merangkai aplikasi di dalam proses uji. Lebih cepat
 * dan lebih mudah diamati, tetapi skenario terpenting Step 20 — proses mati di
 * tengah saga — lalu kembali menjadi "galat yang tidak ditangkap" seperti di
 * Step 19, bukan proses yang benar-benar hilang beserta koneksi, timer, dan
 * transaksi yang sedang terbuka. `index.ts` setiap service juga baru pertama
 * kali dijalankan di sini (lihat README booking-service).
 */

export interface ServiceSpec {
  readonly name: string
  readonly appDir: string
  readonly port: number
  readonly env: Readonly<Record<string, string>>
}

export interface LogLine {
  readonly level: string
  readonly msg: string
  readonly raw: Record<string, unknown>
}

export interface ServiceProcess {
  readonly name: string
  readonly url: string
  /** Baris log JSON pino yang sudah terbaca, dari seluruh umur proses ini. */
  readonly logs: readonly LogLine[]
  /** Penutupan biasa: SIGTERM, menunggu proses keluar. */
  stop(): Promise<void>
  /** Pembunuhan paksa: SIGKILL. Tidak ada kode penutupan yang sempat berjalan. */
  kill(): Promise<void>
}

const READY_TIMEOUT_MS = 60_000
const EXIT_TIMEOUT_MS = 15_000
/** Baris log terakhir yang disertakan bila proses mati sebelum siap. */
const LOG_TAIL = 30

export async function startService(spec: ServiceSpec): Promise<ServiceProcess> {
  const child = spawn(process.execPath, ['dist/index.js'], {
    cwd: spec.appDir,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: 'info',
      OTEL_ENABLED: 'false',
      PORT: String(spec.port),
      ...spec.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const logs: LogLine[] = []
  const stderr: string[] = []
  collectLines(child, logs, stderr)

  const url = `http://localhost:${String(spec.port)}`
  try {
    await waitUntilReady(spec.name, url, child, { stderr, logs })
  } catch (error) {
    // Proses yang tidak siap dalam batas waktu masih hidup; jangan tinggalkan.
    await terminate(child, 'SIGKILL')
    throw error
  }

  return {
    name: spec.name,
    url,
    logs,
    stop: async () => {
      await terminate(child, 'SIGTERM')
    },
    kill: async () => {
      await terminate(child, 'SIGKILL')
    },
  }
}

function collectLines(child: ChildProcess, logs: LogLine[], stderr: string[]): void {
  let pending = ''
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
    pending += chunk
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) {
      const parsed = parseLine(line)
      if (parsed !== undefined) logs.push(parsed)
    }
  })
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    stderr.push(chunk)
    // Ikut ke log yang ditulis dumpLogs: pesan fatal V8 dan Node ("FATAL
    // ERROR", "Fatal process out of memory") hanya muncul di stderr, bukan
    // di log JSON pino. Tanpa ini, service yang mati hanya tampak sebagai log
    // yang berhenti begitu saja — persis yang terjadi pada putaran ketiga
    // Step 20 sebelum baris ini ada.
    logs.push({ level: 'stderr', msg: chunk, raw: { stream: 'stderr', text: chunk } })
  })
  // Kematian proses dicatat sebagai baris log juga, dengan kode keluarnya.
  // Kematian yang DISENGAJA (stop/kill dari harness) pun dicatat — sinyalnya
  // yang membedakan.
  child.once('exit', (code, signal) => {
    logs.push({
      level: 'exit',
      msg: `proses keluar: kode ${String(code)}, sinyal ${String(signal)}`,
      raw: { stream: 'exit', code, signal, at: new Date().toISOString() },
    })
  })
}

function parseLine(line: string): LogLine | undefined {
  if (!line.startsWith('{')) return undefined
  try {
    const raw: unknown = JSON.parse(line)
    if (typeof raw !== 'object' || raw === null) return undefined
    const record = Object.fromEntries(Object.entries(raw))
    return { level: String(record.level), msg: String(record.msg ?? ''), raw: record }
  } catch {
    return undefined
  }
}

async function waitUntilReady(
  name: string,
  url: string,
  child: ChildProcess,
  output: { readonly stderr: readonly string[]; readonly logs: readonly LogLine[] },
): Promise<void> {
  // 'close', bukan 'exit': 'exit' dapat terbit sebelum stdout dan stderr
  // selesai dikuras, dan pesan terakhir proses yang mati — satu-satunya
  // petunjuk penyebabnya — hilang. Putaran Step 20 menemukan booking-service
  // yang keluar dengan 0xC0000409 dan stderr kosong.
  let exited: number | null = null
  child.once('close', (code) => {
    exited = code ?? -1
  })

  await eventually(
    `${name} siap di ${url}`,
    async () => {
      if (exited !== null) {
        const lastLogs = output.logs
          .slice(-LOG_TAIL)
          .map((line) => JSON.stringify(line.raw))
          .join('\n')
        throw new Error(
          `${name} keluar sebelum siap (kode ${String(exited)}):\n${output.stderr.join('')}\n` +
            `log terakhir:\n${lastLogs}`,
        )
      }
      try {
        const response = await request(`${url}/health/ready`)
        await response.body.dump()
        return response.statusCode === 200
      } catch {
        return false
      }
    },
    READY_TIMEOUT_MS,
  )
}

async function terminate(child: ChildProcess, signal: NodeJS.Signals): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return

  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => {
      resolve()
    })
  })
  child.kill(signal)
  await eventually(
    `proses keluar setelah ${signal}`,
    async () => {
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 100))])
      return child.exitCode !== null || child.signalCode !== null
    },
    EXIT_TIMEOUT_MS,
  )
}
