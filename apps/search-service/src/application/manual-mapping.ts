import { CERTAIN } from '../domain/mapping.js'
import { normalizeName, uniqueSlug } from '../domain/slug.js'
import type { Property } from '../domain/property.js'
import type { CatalogDeps } from './ports.js'

/**
 * Pemetaan manual oleh operator.
 *
 * Antrian properti belum terpetakan hanya berguna kalau ada cara
 * menyelesaikannya. Dua cara: menunjuk properti yang sudah ada, atau membuat
 * properti baru dari data mentah supplier.
 *
 * Pemetaan manual ditandai PASTI. Operator yang melihat dua nama dan
 * memutuskan keduanya hotel yang sama lebih dapat dipercaya daripada algoritma
 * kemiripan mana pun — itulah alasan antrian ini ada alih-alih pencocokan
 * otomatis.
 */

export type MapResult =
  | { readonly ok: true; readonly propertyId: string; readonly created: boolean }
  | { readonly ok: false; readonly reason: 'unmapped_not_found' | 'property_not_found' }

export interface MapToExisting {
  readonly supplierId: string
  readonly supplierPropertyId: string
  readonly propertyId: string
  readonly operator: string
}

export async function mapToExistingProperty(
  deps: CatalogDeps,
  input: MapToExisting,
): Promise<MapResult> {
  const [pending, property] = await Promise.all([
    deps.unmapped.find(input.supplierId, input.supplierPropertyId),
    deps.properties.byId(input.propertyId),
  ])

  if (pending === undefined) return { ok: false, reason: 'unmapped_not_found' }
  if (property === undefined) return { ok: false, reason: 'property_not_found' }

  await deps.mappings.put({
    supplierId: input.supplierId,
    supplierPropertyId: input.supplierPropertyId,
    propertyId: input.propertyId,
    confidence: CERTAIN,
    mappedBy: input.operator,
  })

  // Baris antrian ditandai selesai, bukan dihapus: penghitung kemunculannya
  // menjelaskan berapa banyak pencarian yang sempat terpengaruh, dan itu satu-
  // satunya ukuran seberapa mendesak antrian ini dikerjakan.
  await deps.unmapped.resolve(input.supplierId, input.supplierPropertyId)

  return { ok: true, propertyId: input.propertyId, created: false }
}

export interface CreateFromUnmapped {
  readonly supplierId: string
  readonly supplierPropertyId: string
  readonly name: string
  readonly city: string
  readonly countryCode: string
  readonly timezone: string
  readonly address: string
  readonly latitude: number
  readonly longitude: number
  readonly starRating: number
  readonly operator: string
  readonly newId: () => string
  readonly takenSlugs: ReadonlySet<string>
}

export async function createPropertyFromUnmapped(
  deps: CatalogDeps,
  input: CreateFromUnmapped,
): Promise<MapResult> {
  const pending = await deps.unmapped.find(input.supplierId, input.supplierPropertyId)
  if (pending === undefined) return { ok: false, reason: 'unmapped_not_found' }

  const property: Property = {
    id: input.newId(),
    slug: uniqueSlug({ name: input.name, city: input.city }, input.takenSlugs),
    name: input.name,
    normalizedName: normalizeName(input.name),
    address: input.address,
    city: input.city,
    countryCode: input.countryCode,
    latitude: input.latitude,
    longitude: input.longitude,
    timezone: input.timezone,
    starRating: input.starRating,
    amenities: [],
    photos: [],
  }

  await deps.properties.upsertMany([property])
  await deps.mappings.put({
    supplierId: input.supplierId,
    supplierPropertyId: input.supplierPropertyId,
    propertyId: property.id,
    confidence: CERTAIN,
    mappedBy: input.operator,
  })
  await deps.unmapped.resolve(input.supplierId, input.supplierPropertyId)

  return { ok: true, propertyId: property.id, created: true }
}
