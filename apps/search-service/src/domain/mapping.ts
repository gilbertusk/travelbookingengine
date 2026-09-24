/**
 * Pemetaan pengenal supplier ke properti internal.
 *
 * Ini konsekuensi langsung dari ADR-0001: deduplikasi adalah PENCARIAN DI
 * TABEL, bukan pencocokan kabur saat berjalan. Yang hidup di berkas ini
 * karena itu sengaja sederhana — pencarian di sebuah peta, tanpa perbandingan
 * nama, tanpa jarak koordinat, tanpa ambang kemiripan.
 *
 * Kesederhanaan itu adalah keputusannya, bukan kekurangannya. Pencocokan
 * berbasis nama rapuh terhadap variasi penulisan yang justru sengaja ditanam
 * di data uji, biayanya dibayar pada setiap pencarian, dan hasilnya tidak
 * deterministik: dua pencarian yang sama dapat menghasilkan pengelompokan
 * berbeda ketika satu supplier lambat menjawab.
 */

export interface PropertyMapping {
  readonly supplierId: string
  readonly supplierPropertyId: string
  readonly propertyId: string
  /** Basis poin: 10000 berarti pasti. */
  readonly confidence: number
  readonly mappedBy: string
}

/** Pemetaan yang pasti benar: dibangun dari data seed atau ditetapkan operator. */
export const CERTAIN = 10_000

/**
 * Tabel pencarian pemetaan.
 *
 * Bentuknya peta datar dengan kunci gabungan, bukan peta bersarang per
 * supplier. Alasannya menyangkut lapisan lain: tabel ini disimpan di Redis
 * sebagai satu hash, dan hash datar dapat dibaca dengan satu perintah.
 */
export type MappingTable = ReadonlyMap<string, string>

export function mappingKey(supplierId: string, supplierPropertyId: string): string {
  return `${supplierId}:${supplierPropertyId}`
}

export function buildMappingTable(mappings: readonly PropertyMapping[]): MappingTable {
  const table = new Map<string, string>()

  for (const mapping of mappings) {
    table.set(mappingKey(mapping.supplierId, mapping.supplierPropertyId), mapping.propertyId)
  }

  return table
}

/**
 * Hasil penyelesaian satu pengenal supplier.
 *
 * `unmapped` bukan kegagalan. Ia keadaan yang sah dan diharapkan: supplier
 * menambah properti baru setiap saat, dan sistem yang memperlakukannya sebagai
 * galat akan membuang inventaris yang sebenarnya dapat dijual.
 */
export type Resolution =
  { readonly kind: 'mapped'; readonly propertyId: string } | { readonly kind: 'unmapped' }

export function resolveProperty(
  table: MappingTable,
  supplierId: string,
  supplierPropertyId: string,
): Resolution {
  const propertyId = table.get(mappingKey(supplierId, supplierPropertyId))

  return propertyId === undefined ? { kind: 'unmapped' } : { kind: 'mapped', propertyId }
}
