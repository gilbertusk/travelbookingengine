#!/usr/bin/env node
/**
 * Membuktikan tidak ada nilai uang bertipe number, dan tidak ada kolom pecahan
 * biner di skema Prisma mana pun.
 *
 * NFR-08 melarang aritmetika pecahan biner untuk nilai uang. Larangan itu
 * mudah dinyatakan dan hampir mustahil dijaga dengan mata: satu `price:
 * number` tetap dikompilasi dengan benar, tetap lolos setiap uji yang
 * memakai angka bulat, lalu baru ketahuan saat rekonsiliasi tidak pernah cocok
 * dan tidak ada yang tahu sejak kapan.
 *
 * Dua aturan yang diperiksa:
 *
 * 1. Bidang atau parameter yang namanya menyebut uang tidak boleh bertipe
 *    `number`. Tipe [Money] selalu membawa mata uangnya; `number` tidak
 *    membawa apa-apa.
 * 2. Skema Prisma tidak boleh memuat `Float` atau `Decimal`. Uang disimpan
 *    sebagai bilangan bulat satuan terkecil ditambah kolom mata uang.
 *
 *    Larangan ini berlaku menyeluruh, bukan hanya untuk kolom yang namanya
 *    menyebut uang — kolom uang tidak selalu bernama uang. Pengecualiannya
 *    didaftar satu per satu di [ALLOWED_FLOAT_COLUMNS], sehingga setiap
 *    pengecualian adalah keputusan yang tertulis, bukan celah dalam pola.
 *
 * Yang DIIZINKAN bertipe number, dan sengaja: `amountMinor` di dalam package
 * money itu sendiri, basis poin, eksponen, dan skala. Semuanya bukan nilai
 * uang — melainkan bilangan bulat yang menyusunnya.
 *
 * Jalankan: pnpm verify:money
 */
import { globSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

const SOURCE_GLOB = '{apps,packages}/*/src/**/*.{ts,tsx}'
const SCHEMA_GLOB = '{apps,packages}/*/prisma/*.prisma'

const IGNORED_PATHS = [
  'node_modules',
  '/dist/',
  '/generated/',
  '.test.ts',
  '.test.tsx',
  // Package money ADALAH tempat uang bertemu number. Di sinilah satuan
  // terkecil diubah menjadi Money dan sebaliknya; melarangnya di sini berarti
  // melarang package itu ada.
  'packages/money/src/',
  // mock-supplier MENIRU sistem pihak ketiga. Justru tugasnya memancarkan
  // bentuk asing — angka telanjang, string berkoma, sen yang disebut "amount"
  // — karena itulah lapisan kanonik di supplier-adapters ada. Memaksanya
  // memakai tipe Money berarti menghapus satu-satunya hal yang diujinya.
  'apps/mock-supplier/',
]

/**
 * Nama yang menandakan sebuah nilai uang.
 *
 * Sengaja tidak menyertakan `rate` — dalam konteks perjalanan, "rate" berarti
 * rate plan atau kurs, keduanya bukan jumlah uang — dan tidak menyertakan
 * `count` atau `quantity`.
 */
const MONEY_NAMES =
  'price|prices|amount|total|totals|subtotal|markup|tax|taxes|fee|fees|cost|costs|balance|payout|refund|deposit|charge|nightly'

/**
 * Akhiran yang membuat sebuah nama BUKAN nilai uang meski mengandung kata
 * uang: `amountMinor` adalah bilangan bulat satuan terkecil, `taxBasisPoints`
 * adalah basis poin, `priceCheckedAt` adalah waktu, `priceDriftRate` adalah
 * pecahan, dan `totalItems` adalah cacah baris.
 */
const NOT_MONEY_SUFFIX =
  'Minor|MinorUnits|BasisPoints|Bp|Points|Scale|Exponent|At|Count|Items|Length|Index|Id|Ms|Seconds|Rate|Ratio|Factor|Percent|Pct'

const TYPESCRIPT_RULES = [
  {
    name: 'nilai uang bertipe number',
    pattern: new RegExp(
      String.raw`\b(?:readonly\s+)?(${MONEY_NAMES})(?!${NOT_MONEY_SUFFIX})\w*\??\s*:\s*number\b`,
      'gi',
    ),
    why: 'Nilai uang memakai tipe Money, yang selalu membawa mata uangnya. `number` tidak membawa apa-apa — Rp 1.000 dan $1.000 terlihat sama persis.',
  },
  {
    name: 'nilai uang sebagai number di dalam larik',
    pattern: new RegExp(
      String.raw`\b(?:readonly\s+)?(${MONEY_NAMES})(?!${NOT_MONEY_SUFFIX})\w*\??\s*:\s*(?:readonly\s+)?number\[\]`,
      'gi',
    ),
    why: 'Sama halnya untuk larik: sekumpulan harga tanpa mata uang tidak dapat dijumlahkan dengan benar.',
  },
]

/**
 * Kolom pecahan yang BUKAN uang, dan karena itu diizinkan.
 *
 * Koordinat geografis adalah pecahan sungguhan: tidak ada satuan terkecil
 * yang masuk akal, tidak ada yang direkonsiliasi dengannya, dan presisi lima
 * desimal sudah setara sekitar satu meter. Menyimpannya sebagai bilangan
 * bulat berskala hanya menambah konversi di setiap tempat yang membacanya.
 */
const ALLOWED_FLOAT_COLUMNS = new Set(['latitude', 'longitude'])

const PRISMA_RULES = [
  {
    name: 'kolom pecahan biner',
    pattern: /^\s*(\w+)\s+(Float|Decimal)\b.*$/gm,
    allow: (match) => ALLOWED_FLOAT_COLUMNS.has(match[1] ?? ''),
    why: 'Float dan Decimal menyimpan uang sebagai pecahan. Uang disimpan sebagai bilangan bulat satuan terkecil (Int atau BigInt) ditambah kolom mata uang. Kolom pecahan yang bukan uang didaftar di ALLOWED_FLOAT_COLUMNS beserta alasannya.',
  },
]

function scan(glob, rules) {
  return globSync(glob, { cwd: ROOT })
    .map((file) => file.replaceAll('\\', '/'))
    .filter((file) => !IGNORED_PATHS.some((ignored) => file.includes(ignored)))
    .flatMap((file) => inspect(file, readFileSync(resolve(ROOT, file), 'utf8'), rules))
}

function inspect(file, source, rules) {
  return rules.flatMap((rule) =>
    [...source.matchAll(rule.pattern)]
      .filter((match) => rule.allow?.(match) !== true)
      .map((match) => ({
        file,
        line: lineNumber(source, match.index),
        rule: rule.name,
        text: match[0].trim(),
        why: rule.why,
      })),
  )
}

function lineNumber(source, index) {
  return source.slice(0, index).split('\n').length
}

const problems = [...scan(SOURCE_GLOB, TYPESCRIPT_RULES), ...scan(SCHEMA_GLOB, PRISMA_RULES)]

if (problems.length === 0) {
  process.stdout.write(
    'Tidak ada nilai uang bertipe number, dan tidak ada kolom pecahan di skema Prisma.\n',
  )
  process.exit(0)
}

for (const problem of problems) {
  process.stderr.write(
    `${problem.file}:${String(problem.line)}  ${problem.rule}: ${problem.text}\n`,
  )
  process.stderr.write(`    ${problem.why}\n`)
}

process.stderr.write(`\n${String(problems.length)} pelanggaran penanganan uang.\n`)
process.exit(1)
