#!/usr/bin/env node
/**
 * Membuktikan komponen hanya memakai token.
 *
 * DESIGN-SYSTEM.md bagian 11 mewajibkan dua hal yang mudah dinyatakan dan
 * sulit dijaga: tidak ada nilai warna mentah di komponen, dan tidak ada nilai
 * jarak di luar skala 4px. Keduanya tidak dapat ditegakkan tipe maupun linter
 * biasa — satu `bg-[#0ea5e9]` tetap dikompilasi dengan benar, terlihat benar
 * di tampilan terang, lalu salah di tampilan gelap tanpa satu pun peringatan.
 *
 * Satu-satunya berkas yang boleh memuat nilai warna adalah berkas token.
 *
 * Jalankan: pnpm verify:tokens
 */
import { globSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const SOURCE_GLOB = 'apps/web/src/**/*.{ts,tsx}'
const TOKEN_FILE = 'apps/web/src/styles/globals.css'

/** Skala 4px: Tailwind menurunkan p-1 = 4px, p-2 = 8px, dan seterusnya. */
const ALLOWED_SPACING_STEPS = new Set([
  '0',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '8',
  '10',
  '12',
  '14',
  '16',
  '20',
  '24',
  '28',
  '32',
  'px',
  'auto',
  'full',
])

const SPACING_PREFIXES = 'p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|gap|gap-x|gap-y|space-x|space-y'

const SPACING_RULE = 'jarak di luar skala 4px'

const RULES = [
  {
    name: 'nilai warna mentah',
    pattern: /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/g,
    why: 'Warna hanya didefinisikan di globals.css sebagai token, lalu dipakai lewat kelas semantik.',
  },
  {
    name: 'warna arbitrer di kelas Tailwind',
    pattern:
      /\b(?:bg|text|border|ring|fill|stroke|from|via|to)-\[[^\]]*(?:#|rgb|hsl|oklch)[^\]]*\]/g,
    why: 'Nilai arbitrer melewati sistem token dan tidak ikut berubah di dark mode.',
  },
  {
    name: 'kelas dark: berisi warna',
    pattern: /\bdark:(?:bg|text|border|ring|fill|stroke)-[a-z0-9[]/g,
    why: 'Dark mode bekerja lewat redefinisi token, bukan kelas dark: di komponen. DESIGN-SYSTEM.md bagian 2.',
  },
  {
    name: SPACING_RULE,
    pattern: new RegExp(String.raw`\b(?:${SPACING_PREFIXES})-(\[[^\]]+\]|[0-9]+\.[0-9]+)`, 'g'),
    why: 'Skala 4px: 4, 8, 12, 16, 24, 32, 48, 64, 96. DESIGN-SYSTEM.md bagian 4.',
  },
]

function findings() {
  return globSync(SOURCE_GLOB, { cwd: ROOT })
    .map((file) => file.replaceAll('\\', '/'))
    .filter((file) => file !== TOKEN_FILE)
    .flatMap((file) => inspect(file, readFileSync(resolve(ROOT, file), 'utf8')))
}

function inspect(file, source) {
  return RULES.flatMap((rule) =>
    [...source.matchAll(rule.pattern)]
      .filter((match) => !isOnScale(rule, match[0]))
      .map((match) => ({
        file,
        line: lineNumber(source, match.index),
        rule: rule.name,
        text: match[0],
        why: rule.why,
      })),
  )
}

function isOnScale(rule, text) {
  if (rule.name !== SPACING_RULE) return false

  return ALLOWED_SPACING_STEPS.has(text.slice(text.lastIndexOf('-') + 1))
}

function lineNumber(source, index) {
  return source.slice(0, index).split('\n').length
}

const problems = findings()

if (problems.length === 0) {
  process.stdout.write('Tidak ada warna mentah maupun jarak di luar skala. Sistem token utuh.\n')
  process.exit(0)
}

for (const problem of problems) {
  process.stderr.write(
    `${problem.file}:${String(problem.line)}  ${problem.rule}: ${problem.text}\n`,
  )
  process.stderr.write(`    ${problem.why}\n`)
}

process.stderr.write(`\n${String(problems.length)} pelanggaran sistem token.\n`)
process.exit(1)
