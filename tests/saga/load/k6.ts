import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Menjalankan satu skenario k6 di kontainer `grafana/k6`.
 *
 * Kontainer, bukan biner lokal: k6 tidak terpasang di mesin pengembang
 * mana pun yang dijamin repositori ini, sedangkan Docker sudah menjadi syarat
 * Testcontainers. Service berjalan di host, jadi dari dalam kontainer mereka
 * dicapai lewat `host.docker.internal`.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const K6_DIR = join(REPO_ROOT, 'infra/k6')
const K6_IMAGE = 'grafana/k6:1.3.0'

export interface K6Run {
  readonly exitCode: number
  /** `--summary-export` k6: metrik beserta ambangnya. */
  readonly summary: K6Summary
  readonly output: string
}

export interface K6Summary {
  readonly metrics: Readonly<Record<string, Readonly<Record<string, number>> | undefined>>
}

export async function runK6(
  script: string,
  name: string,
  env: Readonly<Record<string, string>>,
): Promise<K6Run> {
  await mkdir(join(K6_DIR, 'results'), { recursive: true })
  const summaryFile = `results/${name}.k6.json`
  const args = [
    'run',
    '--rm',
    '--add-host=host.docker.internal:host-gateway',
    '-v',
    `${K6_DIR}:/scripts`,
    '-w',
    '/scripts',
    ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    K6_IMAGE,
    'run',
    '--quiet',
    `--summary-export=${summaryFile}`,
    script,
  ]

  const { code, output } = await run('docker', args)
  await writeFile(join(K6_DIR, `results/${name}.k6.log`), output, 'utf8')
  const summary = JSON.parse(await readFile(join(K6_DIR, summaryFile), 'utf8')) as K6Summary

  return { exitCode: code, summary, output }
}

async function run(
  command: string,
  args: readonly string[],
): Promise<{ code: number; output: string }> {
  return await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: string[] = []
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk.toString()))
    child.once('error', reject)
    child.once('close', (code) => {
      resolveRun({ code: code ?? -1, output: chunks.join('') })
    })
  })
}

/** Nilai satu statistik metrik dari ringkasan k6, atau `undefined`. */
export function stat(summary: K6Summary, metric: string, key: string): number | undefined {
  return summary.metrics[metric]?.[key]
}
