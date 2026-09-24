/**
 * Ringkasan hasil yang disimpan sebagai JSON.
 *
 * Bentuknya sengaja SEMPIT — hanya angka yang benar-benar dikutip di
 * docs/evidence. Ringkasan mentah k6 memuat ratusan bidang, dan berkas bukti
 * yang memuat semuanya tidak dapat dibaca siapa pun; yang dikutip di README
 * lalu diambil dari tempat lain, dan keduanya menyimpang.
 *
 * Ringkasan mentahnya TETAP disimpan berdampingan. Yang sempit untuk dibaca,
 * yang mentah untuk diperiksa ulang ketika angkanya diragukan.
 */

export function summary(name, data) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const prefix = `infra/k6/results/${name}-${stamp}`

  return {
    [`${prefix}.json`]: JSON.stringify(digest(name, data), null, 2),
    [`${prefix}.raw.json`]: JSON.stringify(data, null, 2),
    // Tetap dicetak ke layar supaya yang menjalankannya melihat hasilnya
    // tanpa membuka berkas.
    stdout: render(digest(name, data)),
  }
}

function digest(name, data) {
  const search =
    metric(data, 'http_req_duration{operasi:cari}') ?? metric(data, 'http_req_duration')

  return {
    scenario: name,
    at: new Date().toISOString(),
    requests: count(data, 'http_reqs'),
    latencyMs: {
      p50: round(search?.['p(50)'] ?? search?.med),
      p95: round(search?.['p(95)']),
      p99: round(search?.['p(99)']),
      max: round(search?.max),
    },
    errorRate: round(
      rate(data, 'http_req_failed{operasi:cari}') ?? rate(data, 'http_req_failed'),
      4,
    ),
    checkRate: round(rate(data, 'checks'), 4),
    cacheHitRatio: round(rate(data, 'cache_hit'), 4),
    partialRatio: round(rate(data, 'hasil_parsial'), 4),
    // Ambang yang dilanggar disebut namanya. "Gagal" tanpa menyebut apa yang
    // gagal memaksa siapa pun membuka ringkasan mentah untuk mengetahuinya.
    breached: breached(data),
  }
}

function breached(data) {
  const failed = []

  for (const [name, entry] of Object.entries(data.metrics ?? {})) {
    for (const [expression, result] of Object.entries(entry.thresholds ?? {})) {
      if (result.ok === false) failed.push(`${name}: ${expression}`)
    }
  }

  return failed
}

function metric(data, name) {
  return data.metrics?.[name]?.values
}

function count(data, name) {
  return metric(data, name)?.count ?? 0
}

function rate(data, name) {
  return metric(data, name)?.rate
}

function round(value, digits = 1) {
  if (typeof value !== 'number' || Number.isNaN(value)) return null

  const factor = 10 ** digits

  return Math.round(value * factor) / factor
}

function render(result) {
  const lines = [
    '',
    `  ${result.scenario}`,
    `  permintaan      ${String(result.requests)}`,
    `  p50             ${String(result.latencyMs.p50)} ms`,
    `  p95             ${String(result.latencyMs.p95)} ms   (M1: < 800)`,
    `  p99             ${String(result.latencyMs.p99)} ms   (M2: < 1500)`,
    `  galat           ${percent(result.errorRate)}   (maks 1%)`,
  ]

  if (result.cacheHitRatio !== null) {
    lines.push(`  cache hit       ${percent(result.cacheHitRatio)}   (M3: > 70%)`)
  }

  if (result.partialRatio !== null) {
    lines.push(`  hasil parsial   ${percent(result.partialRatio)}   (tanpa target)`)
  }

  lines.push(
    '',
    result.breached.length === 0
      ? '  SELURUH AMBANG TERPENUHI'
      : `  AMBANG TIDAK TERPENUHI:\n${result.breached.map((item) => `    - ${item}`).join('\n')}`,
    '',
  )

  return lines.join('\n')
}

function percent(value) {
  return value === null ? '—' : `${String(Math.round(value * 1_000) / 10)}%`
}
