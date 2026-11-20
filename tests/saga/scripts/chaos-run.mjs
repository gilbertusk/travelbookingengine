#!/usr/bin/env node
/**
 * `pnpm chaos:run` (Step 28): menjalankan seluruh skenario chaos berurutan,
 * lalu SELALU menulis laporannya — juga bila ada skenario yang gagal.
 *
 * Laporan dirakit dari dua sumber:
 *
 * - `.chaos/vitest.json` — hasil vitest per uji: lulus atau gagal.
 * - `.chaos/results.jsonl` — angka tiap skenario, ditulis uji HANYA setelah
 *   seluruh invariannya lulus.
 *
 * Skenario yang gagal tetap muncul di laporan sebagai GAGAL dengan pesan
 * galatnya. Laporan yang hanya memuat yang lulus adalah laporan yang
 * menyembunyikan persis hal yang dicari rangkaian ini.
 *
 * Pembungkus Node, bukan `vitest ...; node ...` di package.json: sintaks
 * shell itu tidak berjalan di Windows, dan pengembang project ini memakainya.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, '.chaos')

await rm(OUT, { recursive: true, force: true })
await mkdir(OUT, { recursive: true })

const args = [
  'exec',
  'vitest',
  'run',
  '--config',
  'vitest.chaos.config.ts',
  '--reporter=default',
  '--reporter=json',
  `--outputFile.json=${join(OUT, 'vitest.json')}`,
]
const code = await new Promise((done) => {
  const child =
    process.platform === 'win32'
      ? spawn(['pnpm', ...args].join(' '), { cwd: ROOT, stdio: 'inherit', shell: true })
      : spawn('pnpm', args, { cwd: ROOT, stdio: 'inherit' })
  child.once('exit', (exit) => done(exit ?? 1))
})

const records = await readRecords()
const tests = await readTests()
const report = render(tests, records)
await writeFile(join(OUT, 'chaos-report.md'), report, 'utf8')
process.stdout.write(`\n${report}\nLaporan: ${join(OUT, 'chaos-report.md')}\n`)
process.exit(code)

async function readRecords() {
  const file = join(OUT, 'results.jsonl')
  if (!existsSync(file)) return []
  const text = await readFile(file, 'utf8')
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
}

async function readTests() {
  const file = join(OUT, 'vitest.json')
  if (!existsSync(file)) return []
  const json = JSON.parse(await readFile(file, 'utf8'))
  return json.testResults.flatMap((suite) =>
    suite.assertionResults.map((result) => ({
      name: result.title,
      status: result.status,
      durationMs: result.duration ?? null,
      failure: (result.failureMessages ?? []).join('\n').split('\n')[0] ?? '',
    })),
  )
}

function seconds(ms) {
  return ms === null || ms === undefined ? '—' : `${(ms / 1000).toFixed(1)} dtk`
}

function render(tests, records) {
  const lines = [
    '# Laporan chaos',
    '',
    `Dibuat ${new Date().toISOString()}. Lulus: ${tests.filter((t) => t.status === 'passed').length} dari ${tests.length}.`,
    '',
    '| Skenario | Hasil | Pemesanan | Keadaan akhir | NEEDS_REVIEW | Waktu pulih | Durasi uji |',
    '| -------- | ----- | --------- | ------------- | ------------ | ----------- | ---------- |',
  ]
  for (const test of tests) {
    const result = records.find((record) => test.name.includes(record.title))
    const finals =
      result === undefined
        ? '—'
        : Object.entries(result.statuses)
            .map(([status, count]) => `${status} ${count}`)
            .join(', ')
    lines.push(
      `| ${test.name} | ${test.status === 'passed' ? 'lulus' : `**${test.status.toUpperCase()}**`} | ${result?.bookings ?? '—'} | ${finals} | ${result?.statuses.NEEDS_REVIEW ?? 0} | ${seconds(result?.recoveryMs)} | ${seconds(test.durationMs)} |`,
    )
  }
  lines.push('', '## Rincian', '')
  for (const record of records) {
    lines.push(`### ${record.title}`, '', `- Kegagalan: ${record.fault}`)
    for (const note of record.notes) lines.push(`- ${note}`)
    if (record.trace !== undefined) lines.push(`- Trace: \`${record.trace}\``)
    lines.push('')
  }
  const failed = tests.filter((test) => test.status !== 'passed')
  if (failed.length > 0) {
    lines.push('## Gagal', '')
    for (const test of failed) lines.push(`- **${test.name}** — ${test.failure}`)
    lines.push('')
  }
  return lines.join('\n')
}
