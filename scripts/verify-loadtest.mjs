#!/usr/bin/env node
/**
 * Membuktikan skenario uji beban mengukur apa yang diklaimnya.
 *
 * Uji beban punya satu cara gagal yang khas dan sangat mahal: ia berjalan
 * mulus, menghasilkan angka yang bagus, dan angka itu masuk ke README sebagai
 * bukti — padahal yang diukur bukan yang dikira. Generator kriteria yang
 * diam-diam menghasilkan kota yang sama setiap kali menghasilkan p95 yang
 * cemerlang dan rasio cache hit 99%, dan keduanya tidak berarti apa pun.
 *
 * Kegagalan seperti itu TIDAK terlihat dari hasilnya. Ia hanya terlihat
 * dengan memeriksa generatornya, dan itulah yang dilakukan berkas ini.
 *
 * Yang diperiksa:
 *
 *   - Ambang sama persis dengan target M1, M2, M3 di PRD Bab 7.1
 *   - Kondisi degradasi sama persis dengan hipotesis PRD Bab 6
 *   - Kriteria baseline benar-benar bervariasi di keempat sumbunya
 *   - Kriteria cache benar-benar berulang, sesuai rasio yang dinyatakan
 *   - Tidak ada tanggal lampau yang akan ditolak validasi
 *
 * Jalankan: pnpm verify:loadtest
 */
import { MAX_ERROR_RATE, MIN_CACHE_HIT_RATIO, P95_MS, P99_MS } from '../infra/k6/lib/config.mjs'
import {
  DEGRADED_PLAN,
  DOWN_SUPPLIER,
  SLOW_LATENCY_MS,
  SLOW_SUPPLIER,
} from '../infra/k6/lib/chaos.mjs'
import {
  CITIES,
  MAX_DISTINCT_CRITERIA,
  POPULAR_CITIES,
  realisticCriteria,
  toQuery,
  variedCriteria,
} from '../infra/k6/lib/criteria.mjs'
import { DISTINCT_CRITERIA } from '../infra/k6/lib/cache-pattern.mjs'

/** Seperti yang tertulis di PRD. Diubah di sini hanya bila PRD-nya berubah. */
const PRD = { p95Ms: 800, p99Ms: 1_500, maxErrorRate: 0.01, minCacheHitRatio: 0.7 }

/** Seperti yang tertulis di hipotesis PRD Bab 6. */
const HYPOTHESIS = { slowLatencyMs: 3_000, slowCount: 1, downCount: 1 }

const SAMPLE = 500
const TODAY = new Date('2026-09-24T00:00:00Z')

const failures = []

function check(label, condition, detail) {
  if (condition) return

  failures.push(detail === undefined ? label : `${label}\n    ${detail}`)
}

/* -- Ambang sama dengan PRD ------------------------------------------- */

check(
  'ambang p95 menyimpang dari M1',
  P95_MS === PRD.p95Ms,
  `${String(P95_MS)} bukan ${String(PRD.p95Ms)}`,
)
check(
  'ambang p99 menyimpang dari M2',
  P99_MS === PRD.p99Ms,
  `${String(P99_MS)} bukan ${String(PRD.p99Ms)}`,
)
check(
  'batas galat menyimpang dari PRD',
  MAX_ERROR_RATE === PRD.maxErrorRate,
  `${String(MAX_ERROR_RATE)} bukan ${String(PRD.maxErrorRate)}`,
)
check(
  'ambang cache hit menyimpang dari M3',
  MIN_CACHE_HIT_RATIO === PRD.minCacheHitRatio,
  `${String(MIN_CACHE_HIT_RATIO)} bukan ${String(PRD.minCacheHitRatio)}`,
)

/* -- Kondisi degradasi sama dengan hipotesis --------------------------- */

check(
  'latensi supplier lambat menyimpang dari hipotesis',
  SLOW_LATENCY_MS === HYPOTHESIS.slowLatencyMs,
  `${String(SLOW_LATENCY_MS)}ms bukan ${String(HYPOTHESIS.slowLatencyMs)}ms`,
)

const latencySteps = DEGRADED_PLAN.filter((step) => step.path.endsWith('/latency'))
const downSteps = DEGRADED_PLAN.filter((step) => step.path.endsWith('/down'))

check(
  'jumlah supplier yang dilambatkan menyimpang dari hipotesis',
  latencySteps.length === HYPOTHESIS.slowCount,
)
check(
  'jumlah supplier yang dimatikan menyimpang dari hipotesis',
  downSteps.length === HYPOTHESIS.downCount,
)
check(
  'supplier yang dilambatkan dan yang dimatikan tidak boleh sama',
  SLOW_SUPPLIER !== DOWN_SUPPLIER,
  'merusak satu supplier dua kali menyisakan empat supplier sehat, bukan tiga',
)
check(
  'rencana degradasi menyetel latensi tetap, bukan rentang',
  latencySteps.every((step) => step.body.min === step.body.max),
  'rentang membuat sebagian permintaan tidak pernah benar-benar lambat',
)

/* -- Kriteria baseline benar-benar bervariasi -------------------------- */

const varied = Array.from({ length: SAMPLE }, (_unused, index) => variedCriteria(index, TODAY))

check(
  'kriteria baseline tidak menyentuh seluruh kota',
  new Set(varied.map((item) => item.city)).size === CITIES.length,
  'kota yang tidak pernah dicari berarti sebagian katalog tidak pernah diuji',
)
check(
  'tanggal masuk baseline kurang bervariasi',
  new Set(varied.map((item) => item.checkIn)).size >= 30,
)
check(
  'lama menginap baseline kurang bervariasi',
  new Set(varied.map((item) => nights(item))).size >= 3,
)
check(
  'jumlah tamu baseline kurang bervariasi',
  new Set(varied.map((item) => item.guests)).size >= 3,
)

const uniqueVaried = new Set(varied.map((item) => toQuery(item))).size
check(
  'kriteria baseline terlalu sering berulang',
  uniqueVaried >= SAMPLE * 0.9,
  `${String(uniqueVaried)} dari ${String(SAMPLE)} unik — baseline yang berulang mengukur cache, bukan jalur pencarian`,
)

/* -- Kriteria cache benar-benar sebanyak yang diminta ------------------ */

// Inilah janji generator pola cache: tepat sekian kriteria berbeda beredar.
// Meminta 80 lalu diam-diam mendapat 42 berarti rasio cache hit yang diukur
// milik pola yang lain — dan versi pertama generator ini persis begitu.
for (const count of [20, 40, 80, 200]) {
  const realistic = Array.from({ length: count * 3 }, (_unused, index) =>
    realisticCriteria(index, count, TODAY),
  )
  const unique = new Set(realistic.map((item) => toQuery(item))).size

  check(
    `pola cache tidak menghasilkan ${String(count)} kriteria berbeda`,
    unique === count,
    `terukur ${String(unique)}`,
  )
}

check(
  'jumlah kriteria yang dipakai skenario cache melebihi yang dapat dihasilkan',
  DISTINCT_CRITERIA <= MAX_DISTINCT_CRITERIA,
  `${String(DISTINCT_CRITERIA)} > ${String(MAX_DISTINCT_CRITERIA)}`,
)

const cacheSample = Array.from({ length: DISTINCT_CRITERIA }, (_unused, index) =>
  realisticCriteria(index, DISTINCT_CRITERIA, TODAY),
)

check(
  'pola cache tidak menyentuh seluruh kota populer',
  new Set(cacheSample.map((item) => item.city)).size === POPULAR_CITIES.length,
  'trafik yang menumpuk di satu kota saja bukan pola yang meniru kenyataan',
)

/* -- Tidak ada tanggal yang akan ditolak validasi ---------------------- */

const all = [
  ...varied,
  ...Array.from({ length: SAMPLE }, (_unused, index) =>
    realisticCriteria(index, DISTINCT_CRITERIA, TODAY),
  ),
]

const today = '2026-09-24'

check(
  'ada tanggal masuk di masa lampau',
  all.every((item) => item.checkIn >= today),
  'search-service menolaknya dengan 400, dan uji beban melaporkannya sebagai galat sistem',
)
check(
  'ada tanggal keluar yang tidak setelah tanggal masuk',
  all.every((item) => item.checkOut > item.checkIn),
)
check(
  'ada menginap lebih dari 30 malam',
  all.every((item) => nights(item) <= 30),
  'search-service menolaknya dengan 400',
)
check(
  'ada jumlah tamu di luar batas',
  all.every((item) => item.guests >= 1 && item.guests <= 10),
)

/* -- Hasil ------------------------------------------------------------- */

function nights(criteria) {
  return Math.round(
    (Date.parse(`${criteria.checkOut}T00:00:00Z`) - Date.parse(`${criteria.checkIn}T00:00:00Z`)) /
      86_400_000,
  )
}

if (failures.length === 0) {
  process.stdout.write(
    'Skenario uji beban mengukur yang diklaimnya: ambang sama dengan PRD, ' +
      'kondisi degradasi sama dengan hipotesis, kriterianya benar-benar bervariasi.\n',
  )
  process.exit(0)
}

for (const failure of failures) {
  process.stderr.write(`  ${failure}\n`)
}

process.stderr.write(`\n${String(failures.length)} masalah pada skenario uji beban.\n`)
process.exit(1)
