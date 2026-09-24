#!/usr/bin/env node
/**
 * Menjalankan satu skenario uji beban.
 *
 * Tiga tugas, dan ketiganya harus dilakukan di luar k6:
 *
 * 1. **Memeriksa kesiapan.** Uji beban terhadap service yang belum siap
 *    menghasilkan angka yang seluruhnya salah dan terlihat seperti masalah
 *    performa. Gateway dan search-service diperiksa lebih dulu, dan hasilnya
 *    gagal cepat dengan pesan yang menyebutkan apa yang belum menyala.
 *
 * 2. **Menyiapkan kondisi supplier SEBELUM k6 berjalan.** Menyiapkannya dari
 *    dalam skenario berarti VU pertama berjalan sebelum kondisinya sempat
 *    berlaku, dan permintaan-permintaan awal itu mengukur kondisi sehat
 *    sambil dilaporkan sebagai terdegradasi.
 *
 * 3. **Mengembalikan kondisi setelahnya, apa pun yang terjadi.** Termasuk
 *    ketika k6 gagal atau ditekan Ctrl+C. Suntikan yang tertinggal adalah
 *    penyebab paling umum uji berikutnya gagal tanpa sebab yang jelas, dan
 *    yang disalahkan biasanya perubahan kode terakhir.
 *
 * Jalankan: pnpm loadtest:search | :degraded | :cache
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { DEGRADED_PLAN, RESET_PLAN } from './lib/chaos.mjs'

const ROOT = resolve(import.meta.dirname, '../..')

const GATEWAY_URL = process.env.GATEWAY_URL ?? 'http://localhost:4001'
const MOCK_SUPPLIER_URL = process.env.MOCK_SUPPLIER_URL ?? 'http://localhost:4000'
const SEARCH_URL = process.env.SEARCH_URL ?? 'http://localhost:4003'

const SCENARIOS = {
  baseline: { file: 'search-baseline.js', plan: [] },
  degraded: { file: 'search-degraded.js', plan: DEGRADED_PLAN },
  cache: { file: 'search-cache.js', plan: [] },
}

const name = process.argv[2]
const scenario = SCENARIOS[name]

if (scenario === undefined) {
  fail(`skenario tidak dikenal: ${String(name)}. Pilihan: ${Object.keys(SCENARIOS).join(', ')}`)
}

await main(name, scenario)

async function main(scenarioName, config) {
  mkdirSync(resolve(ROOT, 'infra/k6/results'), { recursive: true })

  await ensureReady()

  // Dinormalkan lebih dulu, bukan hanya sesudah. Skenario yang dijalankan
  // setelah skenario terdegradasi yang tertinggal akan melaporkan angka
  // baseline yang jauh lebih buruk.
  await applyPlan(RESET_PLAN)
  await applyPlan(config.plan)

  let code = 1
  try {
    code = await runK6(config.file)
  } finally {
    // `finally`, supaya kondisinya pulih meski k6 gagal atau dihentikan.
    await applyPlan(RESET_PLAN)
  }

  if (code !== 0) {
    process.stderr.write(
      `\n${scenarioName}: ambang tidak terpenuhi atau k6 gagal (kode ${String(code)}).\n` +
        'Ambang JANGAN diturunkan. Selidiki dengan urutan di docs/plan/step-15-search-load-test.md,\n' +
        'lalu catat hasilnya di docs/evidence/search-performance.md — termasuk yang tidak berhasil.\n',
    )
  }

  process.exit(code)
}

/**
 * Memeriksa kesiapan sebelum menembak.
 *
 * `/health/ready`, bukan `/health/live`. Yang hidup belum tentu siap:
 * search-service yang katalognya belum termuat menjawab setiap pencarian
 * dengan properti yang seluruhnya belum terpetakan — hasil yang terlihat
 * berfungsi dan seluruhnya salah.
 */
async function ensureReady() {
  const targets = [
    { name: 'api-gateway', url: `${GATEWAY_URL}/health/ready` },
    { name: 'search-service', url: `${SEARCH_URL}/health/ready` },
    { name: 'mock-supplier', url: `${MOCK_SUPPLIER_URL}/health/live` },
  ]

  const down = []

  for (const target of targets) {
    if (!(await isReady(target.url))) down.push(target.name)
  }

  if (down.length > 0) {
    fail(
      `belum siap: ${down.join(', ')}.\n` +
        'Jalankan infra dan seluruh service lebih dulu — lihat docs/evidence/search-performance.md.',
    )
  }
}

async function isReady(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3_000) })

    return response.ok
  } catch {
    return false
  }
}

async function applyPlan(plan) {
  for (const step of plan) {
    try {
      const response = await fetch(`${MOCK_SUPPLIER_URL}${step.path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(step.body),
        signal: AbortSignal.timeout(5_000),
      })

      if (!response.ok) {
        fail(
          `gagal menyiapkan kondisi (${step.what}): mock-supplier menjawab ${String(response.status)}`,
        )
      }

      process.stdout.write(`  ${step.what}\n`)
    } catch (error) {
      // Kegagalan menyiapkan kondisi TIDAK boleh diteruskan menjadi uji yang
      // tetap berjalan. Uji terdegradasi yang suppliernya ternyata sehat akan
      // melaporkan angka yang bagus untuk klaim yang tidak pernah diuji.
      fail(`gagal menyiapkan kondisi (${step.what}): ${String(error)}`)
    }
  }
}

/**
 * Menjalankan k6, lewat biner lokal bila ada dan lewat Docker bila tidak.
 *
 * Keduanya disediakan karena keduanya dipakai: di mesin pengembang biner
 * lokal lebih cepat, di CI image Docker menghilangkan satu langkah
 * pemasangan. Yang tidak disediakan adalah jalan ketiga — k6 yang dipasang
 * diam-diam saat uji dijalankan.
 */
function runK6(file) {
  const useDocker = process.env.K6_DOCKER === '1'

  const command = useDocker ? 'docker' : 'k6'
  const args = useDocker
    ? [
        'run',
        '--rm',
        '-i',
        '--network',
        'host',
        '-v',
        `${ROOT}/infra/k6:/scripts`,
        '-w',
        '/scripts',
        'grafana/k6:latest',
        'run',
        `/scripts/${file}`,
      ]
    : ['run', file]

  return new Promise((resolveCode) => {
    const child = spawn(command, args, {
      cwd: useDocker ? ROOT : resolve(ROOT, 'infra/k6'),
      stdio: 'inherit',
      env: { ...process.env, GATEWAY_URL, MOCK_SUPPLIER_URL },
      shell: process.platform === 'win32',
    })

    child.on('error', (error) => {
      process.stderr.write(
        `\nk6 tidak dapat dijalankan: ${String(error)}\n` +
          'Pasang k6 (https://k6.io/docs/get-started/installation/) atau jalankan dengan K6_DOCKER=1.\n',
      )
      resolveCode(127)
    })

    child.on('close', (code) => {
      resolveCode(code ?? 1)
    })
  })
}

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}
