import { createHash } from 'node:crypto'
import { z } from 'zod'

/**
 * Kriteria pencarian, dinormalkan.
 *
 * Normalisasi bukan kerapian — ia yang menentukan apakah cache bekerja.
 * "bali" dan "Bali", spasi berlebih, dan urutan penyaring yang berbeda
 * semuanya adalah pencarian yang SAMA bagi pengguna. Kalau kuncinya berbeda,
 * setiap variasi ejaan memicu fan-out sendiri, dan tingkat kena cache runtuh
 * tanpa satu pun galat yang terlihat.
 *
 * Sebaliknya, kriteria yang benar-benar berbeda TIDAK boleh bertabrakan di
 * kunci yang sama — hasil untuk dua tamu yang disajikan kepada pemesan empat
 * tamu adalah kesalahan yang baru ketahuan saat pemesanannya ditolak.
 */

export const SORT_ORDERS = ['price', 'rating', 'relevance'] as const
export type SortOrder = (typeof SORT_ORDERS)[number]

/** Menginap terpanjang yang masuk akal. Di atas ini hampir pasti salah ketik. */
export const MAX_STAY_NIGHTS = 30

/** Sejauh mana ke depan pencarian diterima. */
export const MAX_ADVANCE_DAYS = 500

export const MAX_GUESTS = 10

export const searchCriteriaSchema = z.object({
  city: z.string().min(2).max(120),
  checkIn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'bukan tanggal kalender'),
  checkOut: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'bukan tanggal kalender'),
  guests: z.number().int().positive().max(MAX_GUESTS),
  sort: z.enum(SORT_ORDERS).default('relevance'),
  minStarRating: z.number().int().min(0).max(5).optional(),
  maxTotalMinor: z.number().int().positive().optional(),
  amenities: z.array(z.string().min(1).max(40)).max(20).default([]),
  refundableOnly: z.boolean().default(false),
  breakfastIncluded: z.boolean().default(false),
})

export type SearchCriteria = z.infer<typeof searchCriteriaSchema>

export type CriteriaProblem =
  'checkout_not_after_checkin' | 'stay_too_long' | 'check_in_in_past' | 'too_far_ahead'

/**
 * Pemeriksaan yang tidak dapat dinyatakan skema.
 *
 * Ketiganya bergantung pada hubungan antar bidang atau pada hari ini, dan
 * keduanya di luar jangkauan validasi per bidang. Dipisahkan dari skema
 * supaya `today` dapat dioper pada pengujian — validasi tanggal yang memanggil
 * `new Date()` sendiri hanya dapat diuji dengan menunggu besok.
 */
export function validateCriteria(
  criteria: SearchCriteria,
  today: string,
): CriteriaProblem | undefined {
  if (criteria.checkOut <= criteria.checkIn) return 'checkout_not_after_checkin'
  if (nightsBetween(criteria.checkIn, criteria.checkOut) > MAX_STAY_NIGHTS) return 'stay_too_long'

  // Perbandingan string cukup: tanggal kalender ISO berurutan secara leksikal,
  // dan membandingkannya sebagai string menghindari seluruh persoalan zona
  // waktu yang muncul begitu `new Date('2026-11-10')` dipakai.
  if (criteria.checkIn < today) return 'check_in_in_past'
  if (daysBetween(today, criteria.checkIn) > MAX_ADVANCE_DAYS) return 'too_far_ahead'

  return undefined
}

const MS_PER_DAY = 86_400_000

export function nightsBetween(checkIn: string, checkOut: string): number {
  return daysBetween(checkIn, checkOut)
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_PER_DAY)
}

/**
 * Bentuk baku kriteria.
 *
 * Kota dikecilkan hurufnya dan spasinya dirapikan; fasilitas dikecilkan,
 * dibuang gandanya, lalu diurutkan. Yang terakhir itu yang mudah terlewat:
 * `['wifi','pool']` dan `['pool','wifi']` adalah penyaring yang sama, dan
 * tanpa pengurutan keduanya menjadi dua kunci cache yang berbeda.
 */
export function normalize(criteria: SearchCriteria): SearchCriteria {
  return {
    ...criteria,
    city: criteria.city.trim().replace(/\s+/g, ' ').toLowerCase(),
    amenities: [...new Set(criteria.amenities.map((item) => item.trim().toLowerCase()))].sort(),
  }
}

/**
 * Kunci cache lapis pertama: hasil gabungan.
 *
 * Memuat SELURUH bidang yang memengaruhi hasilnya, termasuk penyaring dan
 * urutan. Meninggalkan satu bidang akan membuat dua pencarian yang berbeda
 * berbagi satu entri cache, dan hasil yang salah dari cache jauh lebih sulit
 * dilacak daripada hasil yang salah dari perhitungan.
 */
export function resultCacheKey(criteria: SearchCriteria): string {
  return `search:results:${digest(normalize(criteria))}`
}

/**
 * Kunci cache lapis kedua: jawaban mentah satu supplier.
 *
 * Hanya memuat apa yang benar-benar dikirim ke supplier — kota, tanggal,
 * jumlah tamu. Penyaring dan urutan TIDAK ikut: keduanya diterapkan pada
 * hasil, bukan pada permintaan, dan menyertakannya akan memecah entri cache
 * per kombinasi penyaring sementara jawaban supplier-nya sama persis.
 *
 * Inilah yang membuat jawaban supplier lambat tetap berguna pada pencarian
 * berikutnya meski penyaringnya berbeda.
 */
export function supplierCacheKey(supplier: string, criteria: SearchCriteria): string {
  const normalized = normalize(criteria)

  return `search:supplier:${supplier}:${digest({
    city: normalized.city,
    checkIn: normalized.checkIn,
    checkOut: normalized.checkOut,
    guests: normalized.guests,
  })}`
}

/** Awalan kunci per kota, untuk pembatalan cache oleh operasi. */
export function cityTag(criteria: SearchCriteria): string {
  return `search:city:${normalize(criteria).city}`
}

function digest(value: unknown): string {
  // Kunci objek diurutkan sebelum diserialkan. `JSON.stringify` mempertahankan
  // urutan penyisipan, jadi dua objek dengan isi sama tetapi urutan bidang
  // berbeda akan menghasilkan hash berbeda — dan urutan bidang bergantung pada
  // cara pemanggil menyusunnya, yang bukan sesuatu yang boleh memengaruhi cache.
  return createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 32)
}

function stableStringify(value: unknown): string {
  // `undefined` sudah disaring di bawah sebelum sampai ke sini, jadi
  // `JSON.stringify` pada cabang ini selalu mengembalikan string.
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)

  return `{${entries.join(',')}}`
}
