import { z } from 'zod'

/**
 * Kriteria pencarian, disimpan di URL.
 *
 * URL adalah satu-satunya sumber kebenaran untuk kriteria — bukan state
 * React yang kebetulan juga menulis ke URL. Konsekuensinya ada tiga dan
 * semuanya diminta FR-01:
 *
 *   - Halaman hasil dapat dibagikan, dan yang menerimanya melihat hasil sama
 *   - Muat ulang tidak menghapus apa pun
 *   - Tombol kembali peramban bekerja seperti yang diharapkan pengguna
 *
 * Nama parameternya bahasa Indonesia karena URL-nya dilihat pengguna, dan
 * `?kota=bali&mulai=2026-11-10` lebih dapat dibaca daripada `?c=bali&s=…`.
 * Penerjemahan ke nama yang dipakai API terjadi di satu tempat, di bawah.
 */

export const SORT_ORDERS = ['relevansi', 'harga', 'bintang'] as const
export type SortOrder = (typeof SORT_ORDERS)[number]

/** Penerjemahan ke nama yang dipahami search-service. */
const SORT_TO_API: Readonly<Record<SortOrder, 'relevance' | 'price' | 'rating'>> = {
  relevansi: 'relevance',
  harga: 'price',
  bintang: 'rating',
}

export const MAX_GUESTS = 8
export const MAX_STAY_NIGHTS = 30

const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

export interface SearchCriteria {
  readonly city: string
  readonly checkIn: string
  readonly checkOut: string
  readonly guests: number
  readonly sort: SortOrder
  readonly minStarRating?: number | undefined
  readonly maxTotalMinor?: number | undefined
  readonly amenities: readonly string[]
  readonly refundableOnly: boolean
  readonly breakfastIncluded: boolean
}

const criteriaSchema = z.object({
  city: z.string().trim().min(2).max(120),
  checkIn: calendarDate,
  checkOut: calendarDate,
  guests: z.coerce.number().int().min(1).max(MAX_GUESTS).catch(2),
  sort: z.enum(SORT_ORDERS).catch('relevansi'),
  minStarRating: z.coerce.number().int().min(1).max(5).optional().catch(undefined),
  maxTotalMinor: z.coerce.number().int().positive().optional().catch(undefined),
  amenities: z.array(z.string().min(1).max(40)).max(20),
  refundableOnly: z.boolean(),
  breakfastIncluded: z.boolean(),
})

/**
 * Membaca kriteria dari query string.
 *
 * Mengembalikan `undefined` bila kriteria intinya — kota dan kedua tanggal —
 * tidak lengkap atau tidak masuk akal. Halaman hasil memakainya untuk
 * membedakan "belum mencari apa pun" dari "mencari dan tidak menemukan": dua
 * keadaan yang tampak sama di layar kalau tidak dibedakan, padahal yang satu
 * butuh formulir dan yang satu butuh saran mengubah kriteria.
 *
 * Parameter yang RUSAK tidak menggagalkan seluruh pencarian. `?tamu=banyak`
 * jatuh ke dua tamu, `?urut=termurah` jatuh ke relevansi. Pengguna yang
 * menerima tautan dengan satu parameter salah ketik tetap melihat hasil,
 * bukan halaman galat — dan `.catch()` pada skema yang membuatnya begitu.
 */
export function parseCriteria(params: URLSearchParams): SearchCriteria | undefined {
  const parsed = criteriaSchema.safeParse({
    city: params.get('kota') ?? '',
    checkIn: params.get('mulai') ?? '',
    checkOut: params.get('selesai') ?? '',
    guests: params.get('tamu') ?? '2',
    sort: params.get('urut') ?? 'relevansi',
    minStarRating: params.get('bintang') ?? undefined,
    maxTotalMinor: params.get('maks') ?? undefined,
    amenities: splitList(params.get('fasilitas')),
    refundableOnly: params.get('refundable') === '1',
    breakfastIncluded: params.get('sarapan') === '1',
  })

  if (!parsed.success) return undefined

  const criteria = parsed.data
  if (!isSaneStay(criteria.checkIn, criteria.checkOut)) return undefined

  return criteria
}

/**
 * Menulis kriteria kembali menjadi query string.
 *
 * Parameter yang bernilai bawaan TIDAK ditulis. URL yang selalu memuat
 * `&urut=relevansi&refundable=0&sarapan=0` menjadi panjang tanpa membawa
 * keterangan apa pun, dan yang dibagikan pengguna adalah URL itu.
 */
export function toQueryString(criteria: SearchCriteria): string {
  const params = new URLSearchParams({
    kota: criteria.city,
    mulai: criteria.checkIn,
    selesai: criteria.checkOut,
  })

  if (criteria.guests !== 2) params.set('tamu', String(criteria.guests))
  if (criteria.sort !== 'relevansi') params.set('urut', criteria.sort)
  if (criteria.minStarRating !== undefined) params.set('bintang', String(criteria.minStarRating))
  if (criteria.maxTotalMinor !== undefined) params.set('maks', String(criteria.maxTotalMinor))
  if (criteria.amenities.length > 0)
    params.set('fasilitas', [...criteria.amenities].sort().join(','))
  if (criteria.refundableOnly) params.set('refundable', '1')
  if (criteria.breakfastIncluded) params.set('sarapan', '1')

  return params.toString()
}

export function searchHref(criteria: SearchCriteria): string {
  return `/cari?${toQueryString(criteria)}`
}

/** Kriteria yang sama harus menghasilkan kunci cache yang sama di TanStack Query. */
export function criteriaKey(criteria: SearchCriteria): string {
  return toQueryString(criteria)
}

/**
 * Bentuk yang dipahami search-service.
 *
 * Satu-satunya tempat nama parameter Indonesia bertemu nama parameter API.
 * Tersebar di banyak tempat, penerjemahan ini akan menyimpang di salah
 * satunya dan menghasilkan penyaring yang diam-diam tidak terkirim.
 */
export function toApiQuery(criteria: SearchCriteria): URLSearchParams {
  const params = new URLSearchParams({
    city: criteria.city,
    checkIn: criteria.checkIn,
    checkOut: criteria.checkOut,
    guests: String(criteria.guests),
    sort: SORT_TO_API[criteria.sort],
  })

  if (criteria.minStarRating !== undefined)
    params.set('minStarRating', String(criteria.minStarRating))
  if (criteria.maxTotalMinor !== undefined)
    params.set('maxTotalMinor', String(criteria.maxTotalMinor))
  if (criteria.amenities.length > 0) params.set('amenities', criteria.amenities.join(','))

  // Ditulis eksplisit `true`/`false`, bukan dibiarkan kosong saat mati.
  // search-service menolak nilai di luar daftar yang dikenalnya, dan
  // membiarkannya kosong berarti mengandalkan bawaan di dua tempat sekaligus.
  params.set('refundableOnly', String(criteria.refundableOnly))
  params.set('breakfastIncluded', String(criteria.breakfastIncluded))

  return params
}

export function nightsBetween(checkIn: string, checkOut: string): number {
  const ms = Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)

  return Math.round(ms / 86_400_000)
}

function isSaneStay(checkIn: string, checkOut: string): boolean {
  const nights = nightsBetween(checkIn, checkOut)

  return nights > 0 && nights <= MAX_STAY_NIGHTS
}

function splitList(value: string | null): readonly string[] {
  if (value === null || value.length === 0) return []

  return [
    ...new Set(
      value
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean),
    ),
  ]
}

/**
 * Penyaring yang sedang aktif, sebagai daftar yang dapat dilepas satu per satu.
 *
 * Bentuk ini yang dibutuhkan chip penyaring. Menurunkannya dari kriteria —
 * alih-alih menyimpan daftar chip sendiri — membuat mustahil ada chip yang
 * tertinggal setelah penyaringnya dilepas lewat jalan lain.
 */
export interface ActiveFilter {
  readonly id: string
  readonly label: string
  readonly remove: (criteria: SearchCriteria) => SearchCriteria
}

export function activeFilters(criteria: SearchCriteria): readonly ActiveFilter[] {
  const filters: ActiveFilter[] = []

  if (criteria.minStarRating !== undefined) {
    filters.push({
      id: 'bintang',
      label: `${String(criteria.minStarRating)} bintang ke atas`,
      remove: (current) => ({ ...current, minStarRating: undefined }),
    })
  }

  if (criteria.maxTotalMinor !== undefined) {
    filters.push({
      id: 'maks',
      label: `Maksimum ${formatRupiah(criteria.maxTotalMinor)}`,
      remove: (current) => ({ ...current, maxTotalMinor: undefined }),
    })
  }

  if (criteria.refundableOnly) {
    filters.push({
      id: 'refundable',
      label: 'Bisa dibatalkan',
      remove: (current) => ({ ...current, refundableOnly: false }),
    })
  }

  if (criteria.breakfastIncluded) {
    filters.push({
      id: 'sarapan',
      label: 'Termasuk sarapan',
      remove: (current) => ({ ...current, breakfastIncluded: false }),
    })
  }

  for (const amenity of criteria.amenities) {
    filters.push({
      id: `fasilitas:${amenity}`,
      label: amenityLabel(amenity),
      remove: (current) => ({
        ...current,
        amenities: current.amenities.filter((item) => item !== amenity),
      }),
    })
  }

  return filters
}

export const AMENITIES = [
  'wifi',
  'pool',
  'parking',
  'gym',
  'spa',
  'restaurant',
  'bar',
  'airport_shuttle',
  'family_rooms',
  'pet_friendly',
] as const

const AMENITY_LABELS: Readonly<Record<string, string>> = {
  wifi: 'WiFi',
  pool: 'Kolam renang',
  parking: 'Parkir',
  gym: 'Pusat kebugaran',
  spa: 'Spa',
  restaurant: 'Restoran',
  bar: 'Bar',
  airport_shuttle: 'Antar-jemput bandara',
  family_rooms: 'Kamar keluarga',
  pet_friendly: 'Ramah hewan',
}

export function amenityLabel(amenity: string): string {
  return AMENITY_LABELS[amenity] ?? amenity
}

/**
 * Rupiah dari satuan terkecil.
 *
 * IDR memakai eksponen 0 — lihat packages/money. Satuan terkecil rupiah
 * adalah rupiah itu sendiri, jadi tidak ada pembagian seratus di sini, dan
 * menambahkannya akan membuat setiap harga seratus kali lebih kecil.
 */
export function formatRupiah(amountMinor: number): string {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0,
  }).format(amountMinor)
}
