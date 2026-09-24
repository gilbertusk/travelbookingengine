import { sleep } from 'k6'
import { SEARCH_THRESHOLDS } from './lib/config.mjs'
import { variedCriteria } from './lib/criteria.mjs'
import { isPartial, search } from './lib/search.mjs'
import { summary } from './lib/summary.mjs'
import { Rate } from 'k6/metrics'

/**
 * Terdegradasi: satu supplier 3 detik, satu supplier mati.
 *
 * INILAH skenario yang membuktikan hipotesis PRD Bab 6, dan satu-satunya
 * tempat M1 benar-benar diuji. Ambangnya sama persis dengan baseline —
 * itulah pokoknya: pencarian harus tetap di bawah 800ms pada p95 MESKIPUN
 * satu supplier merespons 3 detik dan satu lainnya mati.
 *
 * Melonggarkan ambang di sini berarti membuktikan hipotesis yang lain.
 *
 * Kondisi suppliernya disiapkan skrip orkestrasi SEBELUM k6 berjalan, bukan
 * dari dalam skenario: menyiapkannya dari dalam berarti VU pertama berjalan
 * sebelum kondisinya sempat berlaku, dan permintaan-permintaan awal itu
 * mengukur kondisi sehat sambil dilaporkan sebagai terdegradasi.
 */

/**
 * Berapa bagian jawaban yang parsial.
 *
 * Bukan ambang — tidak ada target untuk angka ini. Ia dicatat karena
 * menjelaskan hasil yang lain: p95 yang bagus dengan 0% jawaban parsial
 * berarti supplier lambatnya tidak pernah benar-benar lambat, dan ujinya
 * tidak menguji apa yang dikiranya.
 */
const partialRate = new Rate('hasil_parsial')

export const options = {
  stages: [
    { duration: '30s', target: 10 },
    { duration: '1m', target: 30 },
    { duration: '2m', target: 50 },
    { duration: '30s', target: 0 },
  ],
  thresholds: SEARCH_THRESHOLDS,
}

export default function degraded() {
  const seed = __VU * 1_000 + __ITER
  const { body } = search(variedCriteria(seed))

  partialRate.add(isPartial(body))

  sleep(1)
}

export function handleSummary(data) {
  return summary('search-degraded', data)
}
