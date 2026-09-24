/**
 * Slug properti.
 *
 * Slug adalah bagian URL yang dapat diindeks mesin pencari, dan PRD Bab 12
 * mewajibkan halaman properti dapat diindeks. Dari situ menyusul satu sifat
 * yang mengikat selamanya:
 *
 *   **Slug tidak pernah berubah.**
 *
 * Nama properti berubah — hotel berganti merek, supplier memperbaiki ejaan,
 * operator merapikan kapitalisasi. Kalau slug ikut berubah, setiap URL yang
 * sudah terindeks mesin pencari, sudah dibagikan di pesan, dan sudah tersimpan
 * di penanda buku menjadi 404. Peringkat pencarian yang dibangun berbulan-bulan
 * hilang dalam satu kali penyuntingan nama.
 *
 * Karena itu slug dibangkitkan SEKALI saat properti dibuat, lalu diperlakukan
 * sebagai pengenal permanen — bukan sebagai turunan dari nama.
 */

/** Batas panjang slug sebelum akhiran pembeda. Cukup untuk nama terpanjang. */
const MAX_SLUG_LENGTH = 80

/**
 * Mengubah teks menjadi bentuk yang aman untuk URL.
 *
 * Tanda diakritik diuraikan lebih dulu supaya "Café" menjadi "cafe", bukan
 * "caf" — huruf yang hilang diam-diam membuat dua properti berbeda bertabrakan
 * di slug yang sama.
 */
export function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '')
}

/**
 * Nama yang dinormalkan untuk pencocokan manual.
 *
 * Dipakai operator saat mencari properti yang cocok di antrian properti belum
 * terpetakan — BUKAN untuk memetakan otomatis. Pemetaan otomatis berbasis nama
 * adalah tepat yang ditolak pada ADR-0001.
 */
export function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export interface SlugCandidate {
  readonly name: string
  readonly city: string
}

/**
 * Slug dasar dari nama dan kota.
 *
 * Kota disertakan karena nama hotel berulang antar kota — "Padma Resort" ada
 * di Bali dan di Bandung, dan keduanya properti yang berbeda.
 *
 * Kota tidak diulang bila nama sudah memuatnya. `slugify('Padma Bali Hotel')`
 * ditambah `'bali'` menghasilkan `padma-bali-hotel-bali`, yang jelek dibaca
 * dan tidak menambah kejelasan apa pun.
 */
export function baseSlug(candidate: SlugCandidate): string {
  const name = slugify(candidate.name)
  const city = slugify(candidate.city)

  if (city.length === 0) return name
  if (name.length === 0) return city
  if (name === city || name.includes(`-${city}-`) || name.endsWith(`-${city}`)) return name

  return `${name}-${city}`
}

/**
 * Slug yang dijamin unik terhadap slug yang sudah terpakai.
 *
 * Pembedanya angka berurutan, bukan potongan acak atau pengenal. Dua hotel
 * bernama sama di kota yang sama memang ada — "Ibis Bandung" lebih dari satu —
 * dan `ibis-bandung-2` masih terbaca manusia, masih dapat diketik, dan masih
 * masuk akal ketika muncul di hasil mesin pencari. Potongan UUID tidak.
 */
export function uniqueSlug(candidate: SlugCandidate, taken: ReadonlySet<string>): string {
  const base = baseSlug(candidate)
  if (base.length === 0) throw new RangeError('slug tidak dapat dibangkitkan dari nama kosong')
  if (!taken.has(base)) return base

  // Batasnya tinggi dan tetap ada. Tanpa batas, data yang rusak — misalnya
  // seluruh properti bernama sama — membuat proses berputar tanpa henti
  // alih-alih gagal dengan jelas.
  for (let suffix = 2; suffix <= 1_000; suffix += 1) {
    const attempt = `${base}-${String(suffix)}`
    if (!taken.has(attempt)) return attempt
  }

  throw new RangeError(`tidak dapat membangkitkan slug unik untuk "${base}"`)
}
