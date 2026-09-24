import { z } from 'zod'
import { apiRequest } from '@/lib/api-client'
import { toApiQuery, type SearchCriteria } from './criteria'
import type { PropertyDetailResponse, SearchResponse, Suggestions } from './types'

/**
 * Panggilan jaringan fitur pencarian.
 *
 * Seluruhnya lewat [apiRequest] — CONVENTIONS.md bagian 13. Tidak ada
 * komponen yang memanggil `fetch` sendiri, dan tidak ada satu pun alamat
 * service yang tertulis di sini: semuanya lewat api-gateway.
 */

export async function fetchSearch(
  criteria: SearchCriteria,
  signal?: AbortSignal,
): Promise<SearchResponse> {
  return await apiRequest<SearchResponse>(`/search?${toApiQuery(criteria).toString()}`, {
    ...(signal === undefined ? {} : { signal }),
  })
}

export async function fetchProperty(
  ref: string,
  criteria: SearchCriteria,
  signal?: AbortSignal,
): Promise<PropertyDetailResponse> {
  const path = `/search/properties/${encodeURIComponent(ref)}?${toApiQuery(criteria).toString()}`

  return await apiRequest<PropertyDetailResponse>(path, {
    ...(signal === undefined ? {} : { signal }),
  })
}

/**
 * Saran kota dan properti saat mengetik (FR-08).
 *
 * Kueri pendek dijawab kosong TANPA menyentuh jaringan. Satu atau dua huruf
 * cocok dengan hampir seluruh katalog, jadi jawabannya tidak membantu siapa
 * pun sementara kuerinya paling mahal — dan setiap ketikan memicu satu.
 */
export const MIN_SUGGEST_LENGTH = 2

const EMPTY: Suggestions = { cities: [], properties: [] }

/**
 * Bentuk jawaban saran DIVALIDASI, tidak diandaikan.
 *
 * Kotak pencarian adalah elemen paling menonjol di seluruh aplikasi, dan
 * komponennya membaca dua larik dari jawaban ini. Jawaban yang bentuknya
 * berubah — gateway yang salah merutekan, service yang dikerahkan ulang —
 * membuat pembacaan itu melempar, dan yang runtuh bukan kotak isiannya
 * melainkan seluruh halaman yang memuatnya.
 *
 * Yang gagal divalidasi menjadi daftar saran kosong. Pengguna kehilangan
 * saran otomatis; ia tidak kehilangan halamannya.
 */
const suggestionsSchema = z.object({
  cities: z
    .array(
      z.object({
        city: z.string(),
        countryCode: z.string(),
        propertyCount: z.number(),
      }),
    )
    .catch([]),
  properties: z
    .array(
      z.object({
        slug: z.string(),
        name: z.string(),
        city: z.string(),
        countryCode: z.string(),
        starRating: z.number(),
      }),
    )
    .catch([]),
})

export async function fetchSuggestions(query: string, signal?: AbortSignal): Promise<Suggestions> {
  const trimmed = query.trim()
  if (trimmed.length < MIN_SUGGEST_LENGTH) return EMPTY

  const raw = await apiRequest<unknown>(`/catalog/suggest?q=${encodeURIComponent(trimmed)}`, {
    ...(signal === undefined ? {} : { signal }),
  })

  const parsed = suggestionsSchema.safeParse(raw)

  return parsed.success ? parsed.data : EMPTY
}
