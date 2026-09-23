#!/usr/bin/env node
/**
 * Membuktikan aturan import boundary benar-benar menolak pelanggaran.
 *
 * Definisi Selesai Step 01 mensyaratkan bukti, bukan keyakinan. Skrip ini
 * membuat service sementara yang sengaja melanggar arah ketergantungan,
 * menjalankan ESLint terhadapnya, lalu memastikan ESLint memang menolak.
 * Berkas sementara dihapus sesudahnya, sehingga tidak ada galat lint permanen
 * yang tertinggal di repo.
 *
 * Jalankan: pnpm verify:boundaries
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const FIXTURE_DIR = join(process.cwd(), 'apps', '__boundary_check__')

const CASES = [
  {
    name: 'domain mengimpor infrastructure',
    file: 'src/domain/violating.ts',
    content: [
      "import { thing } from '../infrastructure/thing.js'",
      '',
      'export const value = thing',
      '',
    ].join('\n'),
  },
  {
    name: 'domain mengimpor http',
    file: 'src/domain/violating-http.ts',
    content: [
      "import { handler } from '../http/handler.js'",
      '',
      'export const value = handler',
      '',
    ].join('\n'),
  },
  {
    name: 'application mengimpor infrastructure',
    file: 'src/application/violating.ts',
    content: [
      "import { thing } from '../infrastructure/thing.js'",
      '',
      'export const value = thing',
      '',
    ].join('\n'),
  },
  {
    name: 'process.env dibaca di luar config.ts',
    file: 'src/application/env-leak.ts',
    content: ['export const leaked = process.env.SECRET_KEY', ''].join('\n'),
  },
]

const SUPPORTING_FILES = [
  { file: 'src/infrastructure/thing.ts', content: "export const thing = 'thing'\n" },
  { file: 'src/http/handler.ts', content: "export const handler = 'handler'\n" },
  { file: 'src/domain/ok.ts', content: "export const ok = 'ok'\n" },
  {
    file: 'tsconfig.json',
    content: `${JSON.stringify(
      { extends: '../../packages/tsconfig/node.json', include: ['src/**/*'] },
      null,
      2,
    )}\n`,
  },
  {
    file: 'package.json',
    content: `${JSON.stringify(
      { name: '@tbe/boundary-check', version: '0.0.0', private: true, type: 'module' },
      null,
      2,
    )}\n`,
  },
]

function write(relativePath, content) {
  const full = join(FIXTURE_DIR, relativePath)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content, 'utf8')
  return full
}

function cleanup() {
  if (existsSync(FIXTURE_DIR)) rmSync(FIXTURE_DIR, { recursive: true, force: true })
}

// Panggil biner ESLint lewat Node secara langsung. Memakai npx dengan
// shell: true memicu peringatan deprecation Node dan menambah permukaan
// injeksi argumen tanpa alasan.
const ESLINT_BIN = join(process.cwd(), 'node_modules', 'eslint', 'bin', 'eslint.js')

function lint(targetPath) {
  try {
    execFileSync(process.execPath, [ESLINT_BIN, '--no-ignore', '--format', 'json', targetPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return []
  } catch (error) {
    const stdout = typeof error.stdout === 'string' ? error.stdout : ''
    if (!stdout.trim().startsWith('[')) {
      throw new Error(`ESLint gagal dijalankan:\n${error.stderr ?? error.message}`)
    }
    return JSON.parse(stdout).flatMap((result) => result.messages)
  }
}

function main() {
  cleanup()
  const failures = []

  try {
    for (const support of SUPPORTING_FILES) write(support.file, support.content)

    for (const testCase of CASES) {
      const target = write(testCase.file, testCase.content)
      const messages = lint(target)
      const rejected = messages.some(
        (message) =>
          message.ruleId === 'boundaries/element-types' ||
          message.ruleId === 'no-restricted-properties',
      )

      if (rejected) {
        process.stdout.write(`  OK    ditolak: ${testCase.name}\n`)
      } else {
        failures.push(testCase.name)
        process.stdout.write(`  GAGAL diterima padahal melanggar: ${testCase.name}\n`)
      }
    }
  } finally {
    cleanup()
  }

  if (failures.length > 0) {
    process.stdout.write(
      `\nAturan boundary tidak menegakkan ${failures.length} kasus. ` +
        'Perbaiki packages/eslint-config/node.js sebelum melanjutkan.\n',
    )
    process.exit(1)
  }

  process.stdout.write('\nSeluruh pelanggaran boundary tertolak. Aturan aktif.\n')
}

main()
