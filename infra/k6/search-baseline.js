import { sleep } from 'k6'
import { SEARCH_THRESHOLDS } from './lib/config.mjs'
import { variedCriteria } from './lib/criteria.mjs'
import { search } from './lib/search.mjs'
import { summary } from './lib/summary.mjs'

/**
 * Baseline: seluruh supplier sehat, beban naik bertahap.
 *
 * Yang diukur di sini bukan klaim utamanya — M1 diuji pada kondisi
 * TERDEGRADASI, bukan kondisi ideal. Baseline ada untuk dua hal lain:
 * memberi angka pembanding, dan menangkap kemunduran performa yang tidak
 * berhubungan dengan kegagalan supplier.
 *
 * Kriterianya sengaja bervariasi di keempat sumbu, jadi sebagian besar
 * permintaan MELESET dari cache. Baseline yang seluruhnya dilayani cache
 * mengukur Redis, bukan jalur pencarian.
 */

export const options = {
  // Naik bertahap, bukan langsung ke puncak. Lonjakan mendadak mengukur
  // perilaku cold start — kolam koneksi yang belum terisi, JIT yang belum
  // panas — dan itu bukan yang dijanjikan M1.
  stages: [
    { duration: '30s', target: 10 },
    { duration: '1m', target: 30 },
    { duration: '2m', target: 50 },
    { duration: '30s', target: 0 },
  ],
  thresholds: SEARCH_THRESHOLDS,
}

export default function baseline() {
  // Benih dari pengenal VU dan nomor iterasi, bukan dari acak. Uji beban yang
  // benihnya acak menghasilkan sebaran kriteria yang berbeda setiap kali
  // dijalankan, dan dua hasil yang dibandingkan menjadi tidak sebanding.
  const seed = __VU * 1_000 + __ITER

  search(variedCriteria(seed))

  // Jeda antar permintaan per VU. Tanpa jeda, 50 VU menjadi ribuan permintaan
  // per detik — angka yang tidak menyerupai satu pun pola trafik sungguhan.
  sleep(1)
}

export function handleSummary(data) {
  return summary('search-baseline', data)
}
