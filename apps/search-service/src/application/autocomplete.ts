import { normalizeName } from '../domain/slug.js'
import type { Property } from '../domain/property.js'
import type { CatalogDeps } from './ports.js'

/**
 * Saran nama kota dan properti saat pengguna mengetik (FR-08).
 *
 * Memakai full-text PostgreSQL, bukan Elasticsearch. Katalog ini ratusan baris
 * dan jarang berubah; menambah satu sistem pencarian lagi berarti menambah
 * satu sumber kegagalan dan satu salinan data yang harus dijaga tetap sinkron
 * — untuk tabel yang muat di memori. Lihat PRD Bab 12.
 */

/**
 * Panjang minimal sebelum menjawab.
 *
 * Satu atau dua huruf cocok dengan hampir seluruh katalog, jadi jawabannya
 * tidak membantu siapa pun sementara kuerinya paling mahal. Dijawab kosong,
 * bukan ditolak sebagai galat — pengguna sedang mengetik, bukan salah.
 */
const MIN_QUERY_LENGTH = 2

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 25

export interface SuggestionRequest {
  readonly query: string
  readonly limit?: number | undefined
}

export interface Suggestions {
  readonly cities: readonly CitySuggestion[]
  readonly properties: readonly PropertySuggestion[]
}

export interface CitySuggestion {
  readonly city: string
  readonly countryCode: string
  readonly propertyCount: number
}

export interface PropertySuggestion {
  readonly slug: string
  readonly name: string
  readonly city: string
  readonly countryCode: string
  readonly starRating: number
}

export async function suggest(deps: CatalogDeps, request: SuggestionRequest): Promise<Suggestions> {
  const query = normalizeName(request.query)
  if (query.length < MIN_QUERY_LENGTH) return { cities: [], properties: [] }

  const limit = Math.min(Math.max(request.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
  const key = `${query}:${String(limit)}`

  const cached = await deps.suggestions.read(key)
  const matches = cached ?? (await deps.properties.search(query, limit * 3))

  if (cached === undefined) await deps.suggestions.write(key, matches)

  return { cities: citiesOf(matches, query, limit), properties: propertiesOf(matches, limit) }
}

/**
 * Kota disimpulkan dari properti yang cocok, bukan dari tabel kota tersendiri.
 *
 * Kota yang tidak punya satu pun properti tidak berguna sebagai saran: pengguna
 * yang memilihnya mendapat hasil kosong. Menurunkannya dari properti membuat
 * keadaan itu mustahil.
 */
function citiesOf(
  matches: readonly Property[],
  query: string,
  limit: number,
): readonly CitySuggestion[] {
  const counts = new Map<string, CitySuggestion>()

  for (const property of matches) {
    if (!normalizeName(property.city).startsWith(query)) continue

    const existing = counts.get(property.city)
    counts.set(
      property.city,
      existing === undefined
        ? { city: property.city, countryCode: property.countryCode, propertyCount: 1 }
        : { ...existing, propertyCount: existing.propertyCount + 1 },
    )
  }

  return [...counts.values()]
    .sort((a, b) => b.propertyCount - a.propertyCount || a.city.localeCompare(b.city))
    .slice(0, limit)
}

function propertiesOf(matches: readonly Property[], limit: number): readonly PropertySuggestion[] {
  return matches.slice(0, limit).map((property) => ({
    slug: property.slug,
    name: property.name,
    city: property.city,
    countryCode: property.countryCode,
    starRating: property.starRating,
  }))
}
