/**
 * Konfigurasi dan ambang uji beban.
 *
 * Ambangnya diambil langsung dari PRD Bab 7.1, dan ditulis sekali di sini
 * supaya ketiga skenario mustahil menyimpang satu sama lain. Ambang yang
 * disalin ke tiga berkas akan berbeda di salah satunya dalam hitungan minggu,
 * dan yang berbeda itu justru yang dilaporkan lulus.
 *
 * TIDAK boleh diturunkan ketika hasilnya tidak tercapai. Ambang yang
 * dipaskan dengan hasil bukan ambang — ia hanya catatan tentang apa yang
 * kebetulan terjadi. Kalau tidak tercapai: perbaiki sistemnya, atau catat
 * dengan jujur mengapa tidak, beserta apa saja yang sudah dicoba.
 */

/** M1: latensi pencarian p95. */
export const P95_MS = 800

/** M2: latensi pencarian p99. */
export const P99_MS = 1_500

/** Batas tingkat galat, sebagai pecahan. */
export const MAX_ERROR_RATE = 0.01

/** M3: rasio cache hit pada pola pencarian realistis. */
export const MIN_CACHE_HIT_RATIO = 0.7

/**
 * Membaca variabel lingkungan di k6 MAUPUN di Node.
 *
 * k6 memakai `__ENV`, Node memakai `process.env`, dan keduanya tidak ada di
 * lingkungan yang lain. Jembatan ini yang membuat berkas ini dapat diimpor
 * dua-duanya — dan itu yang membuat `pnpm verify:loadtest` dapat memeriksa
 * ambangnya tanpa menjalankan k6 sama sekali.
 */
function env(name, fallback) {
  if (typeof __ENV !== 'undefined') return __ENV[name] ?? fallback
  if (typeof process !== 'undefined') return process.env[name] ?? fallback

  return fallback
}

/**
 * Alamat yang dipakai skenario.
 *
 * Seluruh beban menembak api-gateway, bukan search-service langsung. Itu
 * disengaja: yang diukur M1 adalah latensi yang DIRASAKAN pengguna, dan
 * pengguna melewati gateway — termasuk pembatas lajunya, pemeriksaan
 * identitasnya, dan satu lompatan jaringan tambahannya.
 */
export const GATEWAY_URL = env('GATEWAY_URL', 'http://localhost:4001')

/** Panel kendali mock-supplier. Dipakai skenario terdegradasi. */
export const MOCK_SUPPLIER_URL = env('MOCK_SUPPLIER_URL', 'http://localhost:4000')

/** Endpoint metrik search-service, untuk membaca rasio cache hit. */
export const SEARCH_METRICS_URL = env('SEARCH_METRICS_URL', 'http://localhost:4003/metrics')

/**
 * Ambang bersama untuk ketiga skenario.
 *
 * `http_req_duration` disaring ke permintaan pencarian saja lewat tag.
 * Tanpa penyaringan itu, permintaan penyiapan dan pembacaan metrik ikut
 * terhitung — dan keduanya jauh lebih cepat daripada pencarian, sehingga
 * p95 yang dilaporkan lebih baik daripada yang sebenarnya dialami pengguna.
 */
export const SEARCH_THRESHOLDS = {
  'http_req_duration{operasi:cari}': [`p(95)<${String(P95_MS)}`, `p(99)<${String(P99_MS)}`],
  'http_req_failed{operasi:cari}': [`rate<${String(MAX_ERROR_RATE)}`],
  // Pemeriksaan isi jawaban, bukan sekadar kode status. Pencarian yang
  // menjawab 200 dengan daftar kosong tetap pencarian yang gagal.
  checks: ['rate>0.99'],
}

/**
 * Tag untuk permintaan pencarian.
 *
 * Dipakai di setiap panggilan supaya ambang di atas benar-benar menyaring
 * sesuatu. Tag yang lupa dipasang membuat ambangnya tidak pernah dievaluasi,
 * dan k6 melaporkannya lulus.
 */
export const SEARCH_TAGS = { operasi: 'cari' }
