#!/usr/bin/env node
/**
 * Memeriksa kontras warna memenuhi WCAG AA.
 *
 * DESIGN-SYSTEM.md bagian 9 menetapkan 4.5:1 untuk teks biasa dan 3:1 untuk
 * teks besar. Angka itu tidak dapat dinilai dengan melihat: dua warna yang
 * terasa "cukup kontras" di layar terang kerap gagal diukur, dan pasangan
 * yang benar di satu tema kerap salah di tema lainnya.
 *
 * Token dibaca langsung dari globals.css, lalu oklch diubah ke sRGB di sini —
 * tanpa peramban, sehingga pemeriksaannya dapat diulang kapan saja dan ikut
 * berjalan di CI. Pemeriksaan sekali lewat di peramban hanya membuktikan
 * keadaan sesaat, dan token yang digeser bulan depan tidak akan tertangkap
 * siapa pun.
 *
 * Jalankan: pnpm verify:contrast
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const TOKEN_FILE = resolve(ROOT, 'apps/web/src/styles/globals.css')

const AA_NORMAL = 4.5
const AA_LARGE = 3

/**
 * Pasangan yang benar-benar dipakai komponen.
 *
 * `over` adalah lapisan latar semi-transparan di atas `on` — badge memakai
 * warna semantiknya sendiri sebagai latar tipis, dan kontras teksnya harus
 * diukur terhadap hasil campuran itu, bukan terhadap warna aslinya.
 */
const PAIRS = [
  { name: 'teks utama / latar', fg: 'foreground', bg: 'background', min: AA_NORMAL },
  { name: 'teks utama / kartu', fg: 'foreground', bg: 'card', min: AA_NORMAL },
  { name: 'teks sekunder / latar', fg: 'muted-foreground', bg: 'background', min: AA_NORMAL },
  { name: 'teks sekunder / latar diredam', fg: 'muted-foreground', bg: 'muted', min: AA_NORMAL },
  { name: 'label tombol aksen', fg: 'primary-foreground', bg: 'primary', min: AA_NORMAL },
  { name: 'label tombol merusak', fg: 'destructive-foreground', bg: 'destructive', min: AA_NORMAL },
  { name: 'teks aksen / latar', fg: 'primary', bg: 'background', min: AA_NORMAL },
  { name: 'pesan galat / latar', fg: 'destructive', bg: 'background', min: AA_NORMAL },
  {
    name: 'badge primary',
    fg: 'primary',
    bg: 'card',
    over: { color: 'primary', alpha: 0.08 },
    min: AA_NORMAL,
  },
  {
    name: 'badge success',
    fg: 'success',
    bg: 'card',
    over: { color: 'success', alpha: 0.08 },
    min: AA_NORMAL,
  },
  {
    name: 'badge destructive',
    fg: 'destructive',
    bg: 'card',
    over: { color: 'destructive', alpha: 0.08 },
    min: AA_NORMAL,
  },
  {
    name: 'badge warning',
    fg: 'foreground',
    bg: 'card',
    over: { color: 'warning', alpha: 0.15 },
    min: AA_NORMAL,
  },
  {
    name: 'alert warning',
    fg: 'foreground',
    bg: 'card',
    over: { color: 'warning', alpha: 0.1 },
    min: AA_NORMAL,
  },
  // Cincin fokus adalah elemen antarmuka, bukan teks: ambangnya 3:1.
  { name: 'cincin fokus / latar', fg: 'ring', bg: 'background', min: AA_LARGE },
  { name: 'garis pemisah / latar', fg: 'border', bg: 'background', min: 1.2 },
]

function parseThemes(css) {
  const light = {}
  const dark = {}

  const themeBlock = between(css, '@theme {', '\n}')
  const darkBlock = between(css, "[data-theme='dark'] {", '\n}')

  for (const [name, value] of declarations(themeBlock)) light[name] = value
  for (const [name, value] of declarations(darkBlock)) dark[name] = value

  return { light, dark: { ...light, ...dark } }
}

function between(source, open, close) {
  const start = source.indexOf(open)
  if (start === -1) throw new Error(`Blok "${open}" tidak ditemukan di globals.css`)

  const end = source.indexOf(close, start)
  return source.slice(start + open.length, end)
}

function* declarations(block) {
  for (const match of block.matchAll(/--color-([a-z-]+):\s*(oklch\([^)]*\))\s*;/g)) {
    yield [match[1], match[2]]
  }
}

/** oklch → oklab → sRGB linear → sRGB. */
function toRgb(oklch) {
  const [l, c, hDeg] = oklch
    .slice(oklch.indexOf('(') + 1, oklch.lastIndexOf(')'))
    .trim()
    .split(/\s+/)
    .map(Number)

  const h = (hDeg * Math.PI) / 180
  const a = c * Math.cos(h)
  const b = c * Math.sin(h)

  const lCube = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const mCube = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const sCube = (l - 0.0894841775 * a - 1.291485548 * b) ** 3

  const linear = [
    4.0767416621 * lCube - 3.3077115913 * mCube + 0.2309699292 * sCube,
    -1.2684380046 * lCube + 2.6097574011 * mCube - 0.3413193965 * sCube,
    -0.0041960863 * lCube - 0.7034186147 * mCube + 1.707614701 * sCube,
  ]

  return linear.map(gammaEncode)
}

function gammaEncode(value) {
  const clamped = Math.min(Math.max(value, 0), 1)

  return clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055
}

function relativeLuminance([r, g, b]) {
  const channel = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)

  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function blend(top, bottom, alpha) {
  return top.map((value, index) => value * alpha + bottom[index] * (1 - alpha))
}

function contrast(a, b) {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)

  return (lighter + 0.05) / (darker + 0.05)
}

function measure(tokens, pair) {
  const token = (name) => {
    const value = tokens[name]
    if (value === undefined) throw new Error(`Token --color-${name} tidak ada`)
    return toRgb(value)
  }

  const base = token(pair.bg)
  const background =
    pair.over === undefined ? base : blend(token(pair.over.color), base, pair.over.alpha)

  return contrast(token(pair.fg), background)
}

const { light, dark } = parseThemes(readFileSync(TOKEN_FILE, 'utf8'))

const rows = []
const failures = []

for (const [themeName, tokens] of [
  ['terang', light],
  ['gelap', dark],
]) {
  for (const pair of PAIRS) {
    const ratio = Math.round(measure(tokens, pair) * 100) / 100
    rows.push({ theme: themeName, name: pair.name, ratio, min: pair.min })
    if (ratio < pair.min) failures.push({ theme: themeName, name: pair.name, ratio, min: pair.min })
  }
}

for (const row of rows) {
  const mark = row.ratio < row.min ? 'GAGAL' : '  OK '
  process.stdout.write(
    `${mark}  ${row.theme.padEnd(7)} ${row.name.padEnd(34)} ${row.ratio.toFixed(2).padStart(6)}:1  (min ${String(row.min)})\n`,
  )
}

if (failures.length > 0) {
  process.stderr.write(`\n${String(failures.length)} pasangan warna gagal memenuhi ambangnya.\n`)
  process.exit(1)
}

process.stdout.write(`\n${String(rows.length)} pasangan warna diperiksa, seluruhnya memenuhi.\n`)
