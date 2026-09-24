import { v7 as uuidv7 } from 'uuid'
import { propertySchema, type Property, type UnmappedProperty } from '../domain/property.js'
import type { PropertyMapping } from '../domain/mapping.js'
import type {
  CatalogContents,
  CatalogSource,
  MappingStore,
  PropertyStore,
  UnmappedQueue,
  UnmappedSighting,
} from '../application/ports.js'
import type {
  Property as PropertyRow,
  SupplierPropertyMapping as MappingRow,
  UnmappedProperty as UnmappedRow,
  PrismaClient,
} from '../generated/prisma/client.js'

/**
 * Katalog di Postgres.
 *
 * Disentuh saat memuat katalog ke Redis, saat seed, dan saat operator bekerja
 * dengan antrian — TIDAK pada jalur pencarian. Pembagian itu ditegakkan oleh
 * bentuk port di application/ports.ts, bukan oleh kehati-hatian.
 */

function toProperty(row: PropertyRow): Property | undefined {
  const parsed = propertySchema.safeParse({
    id: row.id,
    slug: row.slug,
    name: row.name,
    normalizedName: row.normalizedName,
    address: row.address,
    city: row.city,
    countryCode: row.countryCode,
    latitude: row.latitude,
    longitude: row.longitude,
    timezone: row.timezone,
    starRating: row.starRating,
    amenities: row.amenities,
    ...(row.description === null ? {} : { description: row.description }),
    photos: row.photos,
  })

  // Baris yang tidak lolos skema dilewati, bukan menggagalkan seluruh
  // pemuatan. Satu properti yang rusak tidak boleh membuat seluruh katalog
  // gagal termuat — dan katalog yang gagal termuat berarti setiap properti
  // dari setiap supplier tampil sebagai belum terpetakan.
  return parsed.success ? parsed.data : undefined
}

function toMapping(row: MappingRow): PropertyMapping {
  return {
    supplierId: row.supplierId,
    supplierPropertyId: row.supplierPropertyId,
    propertyId: row.propertyId,
    confidence: row.confidence,
    mappedBy: row.mappedBy,
  }
}

function toUnmapped(row: UnmappedRow): UnmappedProperty {
  return {
    supplierId: row.supplierId,
    supplierPropertyId: row.supplierPropertyId,
    rawName: row.rawName,
    ...(row.rawAddress === null ? {} : { rawAddress: row.rawAddress }),
    ...(row.rawCity === null ? {} : { rawCity: row.rawCity }),
    ...(row.latitude === null ? {} : { latitude: row.latitude }),
    ...(row.longitude === null ? {} : { longitude: row.longitude }),
    occurrences: row.occurrences,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
  }
}

function toRow(property: Property): Omit<PropertyRow, 'createdAt' | 'updatedAt'> {
  return {
    id: property.id,
    slug: property.slug,
    name: property.name,
    normalizedName: property.normalizedName,
    address: property.address,
    city: property.city,
    countryCode: property.countryCode,
    latitude: property.latitude,
    longitude: property.longitude,
    timezone: property.timezone,
    starRating: property.starRating,
    amenities: [...property.amenities],
    description: property.description ?? null,
    photos: [...property.photos],
  }
}

/** Kolom yang boleh diperbarui pada properti yang sudah ada. Tanpa slug. */
function mutableFields(
  property: Property,
): Omit<PropertyRow, 'createdAt' | 'updatedAt' | 'id' | 'slug'> {
  const row = toRow(property)
  const mutable: Record<string, unknown> = { ...row }
  delete mutable.id
  delete mutable.slug

  return mutable as Omit<PropertyRow, 'createdAt' | 'updatedAt' | 'id' | 'slug'>
}

export function createPrismaCatalogSource(
  prisma: PrismaClient,
  onInvalidRow: (id: string) => void,
): CatalogSource {
  return {
    async load(): Promise<CatalogContents> {
      // Keduanya sekaligus. Katalog yang dimuat separuh — properti baru tanpa
      // pemetaannya — menghasilkan snapshot yang menampilkan hotel sebagai
      // belum terpetakan meski pemetaannya sudah ada di basis data.
      const [propertyRows, mappingRows] = await Promise.all([
        prisma.property.findMany(),
        prisma.supplierPropertyMapping.findMany(),
      ])

      const properties: Property[] = []
      for (const row of propertyRows) {
        const property = toProperty(row)
        if (property === undefined) {
          onInvalidRow(row.id)
          continue
        }

        properties.push(property)
      }

      return { properties, mappings: mappingRows.map(toMapping) }
    },
  }
}

export function createPrismaPropertyStore(prisma: PrismaClient): PropertyStore {
  return {
    async bySlug(slug) {
      const row = await prisma.property.findUnique({ where: { slug } })
      return row === null ? undefined : toProperty(row)
    },

    async byId(id) {
      const row = await prisma.property.findUnique({ where: { id } })
      return row === null ? undefined : toProperty(row)
    },

    async upsertMany(properties) {
      // Satu transaksi per potongan, bukan satu untuk 320 baris: transaksi
      // yang terlalu besar memegang kunci lebih lama daripada yang perlu.
      for (const chunk of chunked(properties, 100)) {
        await prisma.$transaction(
          chunk.map((property) => {
            return prisma.property.upsert({
              where: { id: property.id },
              create: toRow(property),
              // `slug` dan `id` sengaja TIDAK ikut di `update`. Slug permanen;
              // baris yang sudah ada mempertahankan slug-nya meski namanya
              // berubah, dan setiap URL yang sudah terindeks tetap hidup.
              update: mutableFields(property),
            })
          }),
        )
      }
    },

    async existingBySource(supplierId) {
      const rows = await prisma.supplierPropertyMapping.findMany({
        where: { supplierId },
        include: { property: { select: { id: true, slug: true } } },
      })

      return new Map(
        rows.map((row) => [
          row.supplierPropertyId,
          { id: row.property.id, slug: row.property.slug },
        ]),
      )
    },

    async search(query, limit) {
      return await searchProperties(prisma, query, limit)
    },
  }
}

/**
 * Autocomplete dengan full-text PostgreSQL (FR-08).
 *
 * Ditulis sebagai SQL mentah karena Prisma tidak dapat menyatakan
 * `to_tsvector` maupun `websearch_to_tsquery`. Indeksnya dibuat di migrasi —
 * lihat prisma/migrations.
 *
 * `simple` dipakai, bukan `english`: nama hotel Indonesia bukan bahasa
 * Inggris, dan stemming Inggris atas "Padma" atau "Kirana" hanya merusak
 * pencocokan.
 *
 * Dua cara pencocokan digabung dengan OR. Full-text menjawab kata utuh dan
 * memberi peringkat; kemiripan trigram menjawab ketikan yang belum selesai.
 * Autocomplete harus menjawab sejak huruf ketiga, dan pada huruf ketiga belum
 * ada satu pun kata utuh untuk dicocokkan.
 */
async function searchProperties(
  prisma: PrismaClient,
  query: string,
  limit: number,
): Promise<readonly Property[]> {
  const rows = await prisma.$queryRaw<PropertyRow[]>`
    SELECT *
    FROM "properties"
    WHERE to_tsvector('simple', "name" || ' ' || "city") @@ plainto_tsquery('simple', ${query})
       OR "normalized_name" LIKE ${`${query}%`}
       OR lower("city") LIKE ${`${query}%`}
    ORDER BY
      ts_rank(to_tsvector('simple', "name" || ' ' || "city"), plainto_tsquery('simple', ${query})) DESC,
      "name" ASC
    LIMIT ${limit}
  `

  return rows.flatMap((row) => {
    const property = toProperty(row)
    return property === undefined ? [] : [property]
  })
}

export function createPrismaMappingStore(prisma: PrismaClient): MappingStore {
  return {
    async all() {
      return (await prisma.supplierPropertyMapping.findMany()).map(toMapping)
    },

    async upsertMany(mappings) {
      for (const chunk of chunked(mappings, 200)) {
        await prisma.$transaction(chunk.map((mapping) => upsertMapping(prisma, mapping)))
      }
    },

    async put(mapping) {
      await upsertMapping(prisma, mapping)
    },
  }
}

function upsertMapping(prisma: PrismaClient, mapping: PropertyMapping) {
  return prisma.supplierPropertyMapping.upsert({
    where: {
      supplierId_supplierPropertyId: {
        supplierId: mapping.supplierId,
        supplierPropertyId: mapping.supplierPropertyId,
      },
    },
    create: { id: uuidv7(), ...mapping },
    update: {
      propertyId: mapping.propertyId,
      confidence: mapping.confidence,
      mappedBy: mapping.mappedBy,
      mappedAt: new Date(),
    },
  })
}

function upsertSighting(prisma: PrismaClient, entry: UnmappedSighting) {
  return prisma.unmappedProperty.upsert({
    where: {
      supplierId_supplierPropertyId: {
        supplierId: entry.supplierId,
        supplierPropertyId: entry.supplierPropertyId,
      },
    },
    create: {
      id: uuidv7(),
      supplierId: entry.supplierId,
      supplierPropertyId: entry.supplierPropertyId,
      rawName: entry.rawName,
      rawAddress: entry.rawAddress ?? null,
      rawCity: entry.rawCity ?? null,
      latitude: entry.latitude ?? null,
      longitude: entry.longitude ?? null,
      occurrences: entry.occurrences,
    },
    update: {
      // Penghitung DINAIKKAN di basis data, bukan dibaca lalu ditulis dari
      // sini: dua instance yang mencatat properti yang sama bersamaan akan
      // saling menimpa kalau dihitung di proses.
      occurrences: { increment: entry.occurrences },
      lastSeenAt: new Date(),
      rawName: entry.rawName,
    },
  })
}

export function createPrismaUnmappedQueue(prisma: PrismaClient): UnmappedQueue {
  return {
    async recordSeen(entries: readonly UnmappedSighting[]) {
      for (const chunk of chunked(entries, 200)) {
        await prisma.$transaction(chunk.map((entry) => upsertSighting(prisma, entry)))
      }
    },

    async pending(limit) {
      const rows = await prisma.unmappedProperty.findMany({
        where: { resolvedAt: null },
        // Yang paling sering muncul lebih dulu: ia merugikan paling banyak
        // pencarian, dan memetakannya memberi hasil terbesar per menit kerja
        // operator.
        orderBy: [{ occurrences: 'desc' }, { firstSeenAt: 'asc' }],
        take: limit,
      })

      return rows.map(toUnmapped)
    },

    async find(supplierId, supplierPropertyId) {
      const row = await prisma.unmappedProperty.findUnique({
        where: { supplierId_supplierPropertyId: { supplierId, supplierPropertyId } },
      })

      return row?.resolvedAt === null ? toUnmapped(row) : undefined
    },

    async resolve(supplierId, supplierPropertyId) {
      // Ditandai selesai, bukan dihapus. Penghitung kemunculannya menjelaskan
      // berapa banyak pencarian yang sempat terpengaruh, dan itu satu-satunya
      // ukuran seberapa mendesak antrian ini dikerjakan.
      const { count } = await prisma.unmappedProperty.updateMany({
        where: { supplierId, supplierPropertyId, resolvedAt: null },
        data: { resolvedAt: new Date() },
      })

      return count > 0
    },
  }
}

function chunked<T>(items: readonly T[], size: number): readonly (readonly T[])[] {
  const chunks: T[][] = []

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }

  return chunks
}
