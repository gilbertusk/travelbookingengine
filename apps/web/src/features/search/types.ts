/**
 * Bentuk jawaban search-service.
 *
 * Setiap bidang opsional ditulis `?: T | undefined`, bukan `?: T`. Dengan
 * `exactOptionalPropertyTypes`, keduanya berbeda: yang pertama menerima
 * bidang yang ADA tetapi bernilai `undefined`, dan itulah yang datang dari
 * JSON ketika service memilih tidak mengisinya. Menulis `?: T` saja membuat
 * bentuk yang sah di kawat tidak dapat diwakili tipenya.
 *
 * Ditulis ulang di sini, bukan diimpor dari service-nya. Alasannya bukan
 * kemalasan: apa yang dibutuhkan antarmuka adalah KONTRAK, dan mengimpor tipe
 * internal service membuat setiap perubahan di dalamnya — termasuk yang tidak
 * pernah terkirim lewat kawat — memaksa perubahan di sini.
 */

export interface Money {
  readonly amountMinor: number
  readonly currency: 'IDR' | 'USD'
}

export interface Offer {
  readonly supplier: string
  readonly supplierPropertyId: string
  readonly supplierRatePlanId: string
  readonly roomTypeName: string
  readonly ratePlanName: string
  readonly refundable: boolean
  readonly freeCancellationDays?: number | undefined
  readonly breakfastIncluded: boolean
  readonly unitsLeft: number
  readonly total: Money
  readonly base: Money
  readonly markup: Money
  readonly tax: Money
  readonly taxName: string
}

export interface SearchProperty {
  readonly ref: string
  readonly mapped: boolean
  /** Hanya ada untuk properti terpetakan. Tanpa ini tidak ada URL yang stabil. */
  readonly slug?: string | undefined
  readonly name: string
  readonly city?: string | undefined
  readonly address?: string | undefined
  readonly starRating?: number | undefined
  readonly amenities: readonly string[]
  readonly coordinates?: { readonly latitude: number; readonly longitude: number } | undefined
  readonly offers: readonly Offer[]
  readonly suppliers: readonly string[]
  readonly lowestTotal: Money
}

export interface SearchMeta {
  readonly source: 'cache' | 'live' | 'partial_cache'
  readonly ageMs?: number | undefined
  readonly suppliersResponded: readonly string[]
  readonly suppliersTimedOut: readonly string[]
  readonly suppliersUnavailable: readonly string[]
  readonly latencyMs: number
  readonly partial: boolean
}

export interface SearchResponse {
  readonly properties: readonly SearchProperty[]
  readonly meta: SearchMeta
}

export interface PropertyDetailResponse {
  readonly property: SearchProperty
  readonly meta: SearchMeta
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

export interface Suggestions {
  readonly cities: readonly CitySuggestion[]
  readonly properties: readonly PropertySuggestion[]
}

/**
 * Berapa penyedia yang belum berkontribusi.
 *
 * Dipakai PartialResultNotice. Diturunkan dari metadata alih-alih dikirim
 * sebagai angka tersendiri, supaya mustahil ada angka yang tidak cocok dengan
 * daftarnya.
 */
export function pendingSuppliers(meta: SearchMeta): number {
  return meta.suppliersTimedOut.length + meta.suppliersUnavailable.length
}

export function respondedSuppliers(meta: SearchMeta): number {
  return meta.suppliersResponded.length
}
