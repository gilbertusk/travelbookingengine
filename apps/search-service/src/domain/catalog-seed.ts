import { z } from 'zod'
import { CERTAIN, type PropertyMapping } from './mapping.js'
import { normalizeName, uniqueSlug } from './slug.js'
import type { Property } from './property.js'

/**
 * Membangun katalog dan pemetaannya dari kebenaran dasar mock-supplier.
 *
 * Fungsi ini MURNI. Ia menerima jawaban mentah dan mengembalikan properti
 * beserta pemetaannya; tidak ada basis data, tidak ada jaringan, tidak ada
 * jam. Itu yang membuat satu-satunya bagian seed yang memuat keputusan dapat
 * diuji tanpa Postgres menyala — sisanya hanya penulisan baris.
 *
 * Pemetaan dibangun dari data seed, BUKAN dari pencocokan nama. Mencocokkan
 * nama pada tahap seed akan membekukan kesalahan pencocokan ke dalam basis
 * data sebagai kebenaran, dan seluruh pengujian sesudahnya akan mengukur
 * kesalahan itu alih-alih menemukannya.
 */

export const groundTruthSchema = z.object({
  properties: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      city: z.string().min(1),
      countryCode: z.string().length(2),
      address: z.string(),
      latitude: z.number(),
      longitude: z.number(),
      timezone: z.string().min(1),
      starRating: z.number().int(),
      amenities: z.array(z.string()),
      /** Kontak properti (Step 23). Opsional: sumber yang lebih tua belum memuatnya. */
      phone: z.string().min(1).optional(),
      email: z.string().min(1).optional(),
      offeredBy: z.array(
        z.object({
          supplier: z.string().min(1),
          supplierPropertyId: z.string().min(1),
          supplierName: z.string().min(1),
        }),
      ),
    }),
  ),
})

export type GroundTruth = z.infer<typeof groundTruthSchema>
export type GroundTruthProperty = GroundTruth['properties'][number]

export interface SeedPlan {
  readonly properties: readonly Property[]
  readonly mappings: readonly PropertyMapping[]
}

export interface SeedOptions {
  /**
   * Properti yang sudah ada, menurut pengenal sumbernya.
   *
   * Inilah yang membuat seed idempoten: properti yang sudah ada memakai
   * pengenal dan SLUG yang sudah ada, bukan yang baru. Membangkitkan slug
   * baru pada setiap seed akan merusak setiap URL yang sudah terindeks —
   * tepat hal yang slug permanen ada untuk mencegahnya.
   */
  readonly existing?: ReadonlyMap<string, { readonly id: string; readonly slug: string }>
  /** Pembuat pengenal; dapat diganti pada pengujian supaya hasilnya tetap. */
  readonly newId: (sourceId: string) => string
}

export type ExistingProperty = { readonly id: string; readonly slug: string }

export function buildSeedPlan(truth: GroundTruth, options: SeedOptions): SeedPlan {
  const existing: ReadonlyMap<string, ExistingProperty> =
    options.existing ?? new Map<string, ExistingProperty>()
  const taken = new Set<string>([...existing.values()].map((entry) => entry.slug))

  const properties: Property[] = []
  const mappings: PropertyMapping[] = []

  for (const source of truth.properties) {
    const property = toProperty(source, existing.get(source.id), taken, options.newId)
    taken.add(property.slug)
    properties.push(property)

    for (const offer of source.offeredBy) {
      mappings.push({
        supplierId: offer.supplier,
        supplierPropertyId: offer.supplierPropertyId,
        propertyId: property.id,
        // Pasti, karena berasal dari kebenaran dasar dan bukan dari tebakan.
        confidence: CERTAIN,
        mappedBy: 'seed',
      })
    }
  }

  return { properties, mappings }
}

function toProperty(
  source: GroundTruthProperty,
  existing: ExistingProperty | undefined,
  taken: ReadonlySet<string>,
  newId: (sourceId: string) => string,
): Property {
  return {
    id: existing?.id ?? newId(source.id),
    // Slug yang sudah ada dipertahankan meski namanya berubah.
    slug: existing?.slug ?? uniqueSlug({ name: source.name, city: source.city }, taken),
    name: source.name,
    normalizedName: normalizeName(source.name),
    address: source.address,
    city: source.city,
    countryCode: source.countryCode,
    latitude: source.latitude,
    longitude: source.longitude,
    timezone: source.timezone,
    starRating: source.starRating,
    amenities: [...source.amenities],
    photos: [],
    ...(source.phone === undefined ? {} : { phone: source.phone }),
    ...(source.email === undefined ? {} : { email: source.email }),
  }
}

/**
 * Pengenal sumber yang dipakai untuk mencocokkan properti lama dengan baru
 * pada seed berikutnya.
 *
 * Disimpan sebagai pemetaan supplier semu `seed`, bukan sebagai kolom di
 * tabel properti. Alasannya: pengenal mock-supplier tidak punya arti di
 * produksi, dan kolom yang hanya bermakna di lingkungan pengembangan akan
 * terbawa ke skema produksi selamanya.
 */
export const SEED_SOURCE_SUPPLIER = 'seed'

export function seedSourceMappings(truth: GroundTruth, plan: SeedPlan): readonly PropertyMapping[] {
  return truth.properties.flatMap((source, index) => {
    const property = plan.properties[index]
    if (property === undefined) return []

    return [
      {
        supplierId: SEED_SOURCE_SUPPLIER,
        supplierPropertyId: source.id,
        propertyId: property.id,
        confidence: CERTAIN,
        mappedBy: 'seed',
      },
    ]
  })
}
