/**
 * Kriteria pencarian untuk uji beban.
 *
 * Yang paling mudah salah di seluruh Step 15 ada di berkas ini: generator
 * yang diam-diam menghasilkan kriteria yang sama setiap kali. Uji beban
 * seperti itu mengukur satu entri cache dibaca seribu kali — p95-nya bagus,
 * rasio cache hit-nya mendekati 100%, dan keduanya tidak berarti apa pun.
 *
 * Karena itu ada dua generator yang berbeda dengan sengaja:
 *
 *   `variedCriteria`   — sebisa mungkin berbeda-beda. Dipakai baseline dan
 *                        skenario terdegradasi, yang mengukur LATENSI dan
 *                        karena itu harus sering meleset dari cache
 *   `realisticCriteria`— berulang menurut pola yang meniru trafik sungguhan.
 *                        Dipakai skenario cache, yang mengukur RASIO
 *
 * Keduanya murni terhadap `seed` yang dioper, jadi dapat diuji tanpa k6.
 */

/** Kota yang benar-benar ada di katalog mock-supplier. */
export const CITIES = [
  'Bali',
  'Jakarta',
  'Bandung',
  'Yogyakarta',
  'Surabaya',
  'Singapore',
  'Kuala Lumpur',
  'Bangkok',
]

/**
 * Kota populer, untuk pola realistis.
 *
 * Trafik pencarian sungguhan tidak tersebar rata: sebagian besar permintaan
 * menumpuk di segelintir tujuan. Itulah yang membuat cache bekerja, dan
 * skenario yang menyebar permintaan rata ke delapan kota akan melaporkan
 * rasio cache hit yang jauh lebih rendah daripada yang akan terjadi di
 * produksi — lalu menyimpulkan cache-nya tidak berguna.
 */
export const POPULAR_CITIES = ['Bali', 'Jakarta', 'Bandung']

export const MIN_GUESTS = 1
export const MAX_GUESTS = 4

/** Sejauh mana ke depan tanggal menginap dibangkitkan. */
export const MAX_ADVANCE_DAYS = 60

export const MIN_NIGHTS = 1
export const MAX_NIGHTS = 5

const MS_PER_DAY = 86_400_000

/**
 * Kriteria yang berbeda-beda.
 *
 * Variasinya menyentuh keempat sumbu sekaligus — kota, tanggal masuk, lama
 * menginap, jumlah tamu — karena memvariasikan satu sumbu saja tetap
 * menghasilkan tabrakan cache yang sering. Delapan kota dengan tanggal yang
 * sama menghasilkan delapan entri cache, dan seribu permintaan ke delapan
 * entri adalah 99% cache hit.
 *
 * Keempat sumbu diturunkan dari HASH benihnya, bukan dari `seed * k % n`
 * langsung. Versi pertama memakai cara kedua dan hanya menghasilkan 120
 * kriteria berbeda dari 500 benih: keempat pengalinya berbagi faktor, jadi
 * kombinasinya berulang jauh lebih cepat daripada perkalian jumlah nilai di
 * setiap sumbu. Yang menemukannya `pnpm verify:loadtest`, bukan mata —
 * kekeliruan seperti ini menghasilkan uji beban yang berjalan mulus dan
 * mengukur cache alih-alih jalur pencarian.
 */
export function variedCriteria(seed, today = new Date()) {
  return build({
    city: CITIES[hash(seed, 1) % CITIES.length],
    startOffset: 1 + (hash(seed, 2) % MAX_ADVANCE_DAYS),
    nights: MIN_NIGHTS + (hash(seed, 3) % (MAX_NIGHTS - MIN_NIGHTS + 1)),
    guests: MIN_GUESTS + (hash(seed, 4) % (MAX_GUESTS - MIN_GUESTS + 1)),
    today,
  })
}

/**
 * Pencampur benih: splitmix32.
 *
 * Tidak perlu berkualitas kriptografis — yang dibutuhkan hanya dua hal.
 * Pertama, empat sumbu yang diturunkan darinya tidak boleh berulang
 * bersamaan. Kedua, hasilnya TETAP untuk benih yang sama; tanpa itu, dua
 * hasil uji beban tidak dapat dibandingkan karena keduanya menembak kriteria
 * yang berbeda.
 *
 * Percobaan pertama memakai xorshift sederhana dan menghasilkan 448 kriteria
 * berbeda dari 500 benih — sementara batas teoretisnya (tabrakan ulang tahun
 * atas 9.600 kombinasi) adalah 487. Selisih 39 itu bukan kebetulan melainkan
 * pencampuran yang lemah, dan splitmix32 menutupnya: 488 dari 500.
 *
 * Yang diperbaiki generatornya, BUKAN ambang pemeriksaannya. Ambang yang
 * diturunkan sampai kode yang ada lulus bukan ambang.
 */
function hash(seed, salt) {
  let value = (seed + salt * 0x9e37_79b9) | 0
  value = Math.imul(value ^ (value >>> 16), 0x21f0_aaad)
  value = Math.imul(value ^ (value >>> 15), 0x735a_2d97)

  return (value ^ (value >>> 15)) >>> 0
}

/**
 * Pola pencarian yang meniru trafik sungguhan.
 *
 * `distinctCount` adalah berapa banyak kriteria BERBEDA yang beredar. Itulah
 * knop yang sebenarnya, dan menyebutnya begitu adalah koreksi atas rancangan
 * pertama yang menyebutnya "rasio pengulangan".
 *
 * Rasio pengulangan bergantung pada berapa banyak permintaan yang dikirim —
 * seratus permintaan ke empat puluh kriteria berulang 60%, sepuluh ribu
 * permintaan ke empat puluh kriteria yang sama berulang 99,6%. Menyatakan
 * rasio sebagai parameter berarti menyatakan sesuatu yang tidak dapat
 * dipenuhi generator, karena generator tidak tahu berapa kali ia dipanggil.
 *
 * Yang dapat dijanjikan generator: tepat `distinctCount` kriteria berbeda,
 * tersebar di kota-kota populer. Rasio cache hit yang menyusul dapat dihitung
 * dari sana — dan dihitung di skenario, yang memang tahu berapa lama ia
 * berjalan.
 *
 * Keempat sumbu dibagi BERTINGKAT, bukan masing-masing `index % n`. Versi
 * pertama memakai cara kedua dan diam-diam mentok di 42 kriteria berbeda
 * berapa pun `distinctCount` yang diminta: tanggal hanya membentang 14 nilai,
 * dan lama menginap ikut berputar bersama kota karena keduanya memakai
 * `% 3`. Meminta 80 lalu diam-diam mendapat 42 berarti rasio cache hit yang
 * diukur milik pola yang lain.
 */
export const MAX_DISTINCT_CRITERIA = POPULAR_CITIES.length * 28 * 3 * 2

export function realisticCriteria(seed, distinctCount = 40, today = new Date()) {
  const index = seed % Math.max(1, distinctCount)

  const cityIndex = index % POPULAR_CITIES.length
  const rest = Math.floor(index / POPULAR_CITIES.length)

  return build({
    city: POPULAR_CITIES[cityIndex],
    startOffset: 1 + (rest % 28),
    nights: MIN_NIGHTS + (Math.floor(rest / 28) % 3),
    guests: MIN_GUESTS + (Math.floor(rest / 84) % 2),
    today,
  })
}

function build({ city, startOffset, nights, guests, today }) {
  const checkIn = addDays(today, startOffset)

  return {
    city,
    checkIn: toCalendarDate(checkIn),
    checkOut: toCalendarDate(addDays(checkIn, nights)),
    guests,
  }
}

/**
 * Tanggal kalender, bukan titik waktu.
 *
 * Dibangun dari komponen tanggal LOKAL, bukan lewat `toISOString()` yang
 * mengubahnya ke UTC lebih dulu — di Jakarta itu menggeser tanggalnya mundur
 * satu hari, dan uji beban akan mengirim tanggal kemarin yang ditolak
 * validasi. Lihat CONVENTIONS.md bagian 10.
 */
export function toCalendarDate(date) {
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')

  return `${year}-${month}-${day}`
}

function addDays(date, days) {
  return new Date(date.getTime() + days * MS_PER_DAY)
}

/** Kueri yang dikirim ke gateway. */
export function toQuery(criteria) {
  const params = new URLSearchParams({
    city: criteria.city,
    checkIn: criteria.checkIn,
    checkOut: criteria.checkOut,
    guests: String(criteria.guests),
  })

  return params.toString()
}
