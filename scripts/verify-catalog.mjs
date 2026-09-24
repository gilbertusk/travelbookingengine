#!/usr/bin/env node
/**
 * Membuktikan katalog properti tidak menyimpan harga maupun ketersediaan.
 *
 * Ini batas yang menjaga premis dasar project: inventaris bukan milik kita.
 * Katalog menyimpan data STATIS — nama, alamat, koordinat, zona waktu,
 * fasilitas. Harga dan ketersediaan milik supplier, bersumber dari supplier
 * pada setiap pencarian, dan tidak pernah disimpan.
 *
 * Melanggarnya tidak menggagalkan apa pun hari itu juga, dan justru itulah
 * bahayanya. Satu kolom `lowestPrice` terasa praktis saat ditambahkan —
 * ia menghemat satu panggilan, halamannya terasa lebih cepat, dan tidak ada
 * uji yang gagal. Yang terjadi kemudian: angka itu basi dalam hitungan menit,
 * pengguna melihat harga yang tidak ada lagi, lalu pemesanannya ditolak saat
 * pembayaran.
 *
 * Komentar di schema.prisma tidak menghentikan siapa pun. Skrip ini bisa.
 *
 * Jalankan: pnpm verify:catalog
 */
import { globSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

/** Model yang menyusun katalog. Hanya ketiganya yang diperiksa. */
const CATALOG_MODELS = ['Property', 'SupplierPropertyMapping', 'UnmappedProperty']

const SCHEMA_GLOB = 'apps/search-service/prisma/*.prisma'

/**
 * Kata yang menandakan kolom harga atau ketersediaan.
 *
 * `rate` ikut dilarang meski ambigu: dalam domain ini ia hampir selalu berarti
 * tarif, dan kolom katalog yang benar-benar perlu menyebut "rate" belum ada.
 * Larangan yang terlalu longgar tidak menjaga apa pun.
 */
const FORBIDDEN = [
  'price',
  'amount',
  'cost',
  'fare',
  'rate',
  'currency',
  'available',
  'availability',
  'inventory',
  'stock',
  'vacancy',
  'occupancy',
  'ratePlan',
  'roomType',
  'checkIn',
  'checkOut',
]

/** `starRating` bukan tarif, dan `countryCode` bukan mata uang. */
const ALLOWED_COLUMNS = new Set(['starRating', 'countryCode'])

const COLUMN = new RegExp(String.raw`^\s{2}(\w+)\s+\w`, 'gm')
const FORBIDDEN_WORD = new RegExp(`(${FORBIDDEN.join('|')})`, 'i')

function modelsIn(source) {
  const models = []
  const pattern = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm

  for (const match of source.matchAll(pattern)) {
    models.push({ name: match[1], body: match[2] ?? '', index: match.index })
  }

  return models
}

function findings() {
  return globSync(SCHEMA_GLOB, { cwd: ROOT })
    .map((file) => file.replaceAll('\\', '/'))
    .flatMap((file) => inspect(file, readFileSync(resolve(ROOT, file), 'utf8')))
}

function inspect(file, source) {
  return modelsIn(source)
    .filter((model) => CATALOG_MODELS.includes(model.name))
    .flatMap((model) =>
      [...model.body.matchAll(COLUMN)]
        .map((match) => match[1] ?? '')
        .filter((column) => !ALLOWED_COLUMNS.has(column) && FORBIDDEN_WORD.test(column))
        .map((column) => ({
          file,
          model: model.name,
          column,
          why: 'Katalog menyimpan data statis saja. Harga dan ketersediaan bersumber dari supplier pada setiap pencarian, dan tidak pernah disimpan.',
        })),
    )
}

/**
 * Ketiga model wajib ada. Skrip yang memeriksa model yang sudah berganti nama
 * akan lulus tanpa memeriksa apa pun — lulus karena buta, bukan karena bersih.
 */
function missingModels() {
  const present = new Set(
    globSync(SCHEMA_GLOB, { cwd: ROOT }).flatMap((file) =>
      modelsIn(readFileSync(resolve(ROOT, file), 'utf8')).map((model) => model.name),
    ),
  )

  return CATALOG_MODELS.filter((model) => !present.has(model))
}

const absent = missingModels()

if (absent.length > 0) {
  process.stderr.write(
    `Model katalog tidak ditemukan: ${absent.join(', ')}.\n` +
      'Skrip ini memeriksa model menurut namanya; nama yang berubah harus ikut diperbarui di sini.\n',
  )
  process.exit(1)
}

const problems = findings()

if (problems.length === 0) {
  process.stdout.write(
    `Katalog bersih: ${String(CATALOG_MODELS.length)} model diperiksa, tidak ada kolom harga maupun ketersediaan.\n`,
  )
  process.exit(0)
}

for (const problem of problems) {
  process.stderr.write(`${problem.file}  ${problem.model}.${problem.column}\n`)
  process.stderr.write(`    ${problem.why}\n`)
}

process.stderr.write(`\n${String(problems.length)} kolom yang tidak boleh ada di katalog.\n`)
process.exit(1)
