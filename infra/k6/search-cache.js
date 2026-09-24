import { sleep } from 'k6'
import { Rate } from 'k6/metrics'
import { MIN_CACHE_HIT_RATIO, SEARCH_THRESHOLDS } from './lib/config.mjs'
import { realisticCriteria } from './lib/criteria.mjs'
import { search, sourceOf } from './lib/search.mjs'
import { summary } from './lib/summary.mjs'

/**
 * Cache: pola pencarian realistis, mengukur M3.
 *
 * Satu-satunya skenario yang MENGULANG kriteria dengan sengaja, dan alasannya
 * ada di lib/criteria.mjs: trafik pencarian sungguhan menumpuk di segelintir
 * tujuan populer. Menyebarnya rata ke delapan kota akan melaporkan rasio
 * cache hit yang jauh lebih rendah daripada yang terjadi di produksi, lalu
 * menyimpulkan cache-nya tidak berguna.
 *
 * Rasio diukur dari METADATA jawaban (`meta.source`), bukan ditebak dari
 * latensinya. Menebak dari latensi menghitung setiap jawaban cepat sebagai
 * cache hit — termasuk pencarian sungguhan yang kebetulan cepat.
 *
 * Asumsi pengulangannya dinyatakan terang-terangan sebagai `REPEAT_RATIO`.
 * Rasio cache hit yang diukur hanya bermakna kalau asumsi ini terlihat dan
 * dapat diperdebatkan — bukan tersembunyi di dalam generator.
 */

/** Bagian permintaan yang mengulang kriteria yang sudah pernah dipakai. */
const REPEAT_RATIO = 0.8

const cacheHit = new Rate('cache_hit')

export const options = {
  stages: [
    // Pemanasan: mengisi cache lebih dulu dengan beban rendah. Tanpa ini,
    // seluruh permintaan di menit pertama meleset dengan sendirinya, dan
    // rasio yang dilaporkan mencampur "cache belum terisi" dengan "cache
    // tidak bekerja" — dua hal yang sangat berbeda.
    { duration: '30s', target: 5 },
    { duration: '2m', target: 40 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    ...SEARCH_THRESHOLDS,
    // M3. Ambangnya di sini, bukan di config bersama, karena hanya skenario
    // ini yang polanya membuat rasio cache hit berarti apa pun.
    cache_hit: [`rate>${String(MIN_CACHE_HIT_RATIO)}`],
  },
}

export default function cache() {
  const seed = __VU * 1_000 + __ITER
  const { body } = search(realisticCriteria(seed, REPEAT_RATIO))

  // `partial_cache` ikut dihitung sebagai kena: ia berarti sebagian hasilnya
  // datang dari cache lapis kedua, yang persis fungsi yang diukur.
  const source = sourceOf(body)
  cacheHit.add(source === 'cache' || source === 'partial_cache')

  sleep(1)
}

export function handleSummary(data) {
  return summary('search-cache', data)
}
