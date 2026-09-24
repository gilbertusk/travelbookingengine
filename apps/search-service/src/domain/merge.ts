import type { Money } from '@tbe/money'
import type { SupplierCode, SupplierProperty, SupplierSearchResult } from '@tbe/supplier-adapters'
import type { SearchCriteria } from './criteria.js'
import type { Property } from './property.js'

/**
 * Penggabungan hasil dari beberapa supplier.
 *
 * Di sinilah FR-04 benar-benar terjadi: satu hotel fisik yang dijual tiga
 * supplier menjadi SATU entri dengan harga terendah, dan ketiga tawarannya
 * tetap tersimpan untuk halaman detail.
 *
 * Seluruh berkas ini murni. Tidak ada jaringan, tidak ada jam, tidak ada
 * basis data — bahkan pemetaan properti pun datang sebagai snapshot di
 * memori. Itu yang membuat keputusan penggabungan dapat diuji tanpa satu pun
 * supplier menyala.
 */

/**
 * Yang dibutuhkan penggabungan dari katalog.
 *
 * Dinyatakan di sini, di domain, alih-alih mengimpor `CatalogSnapshot` dari
 * lapisan aplikasi — domain tidak boleh tahu apa pun tentang lapisan di
 * atasnya. Snapshot memenuhinya secara struktural, jadi tidak ada adaptor
 * yang perlu ditulis.
 */
export interface PropertyLookup {
  propertyId(supplierId: string, supplierPropertyId: string): string | undefined
  property(propertyId: string): Property | undefined
}

/** Satu tawaran: satu rate plan dari satu supplier untuk satu properti. */
export interface Offer {
  readonly supplier: SupplierCode
  readonly supplierPropertyId: string
  readonly supplierRatePlanId: string
  readonly roomTypeName: string
  readonly ratePlanName: string
  /** Harga supplier. TIDAK pernah dikembalikan ke klien apa adanya. */
  readonly supplierTotal: Money
  readonly refundable: boolean
  readonly freeCancellationDays?: number | undefined
  readonly breakfastIncluded: boolean
  readonly unitsLeft: number
}

export interface MergedProperty {
  /**
   * Pengenal untuk klien.
   *
   * Untuk properti terpetakan: pengenal internal. Untuk yang belum: pengenal
   * gabungan supplier, yang TIDAK stabil dan tidak boleh dipakai sebagai URL.
   */
  readonly ref: string
  readonly mapped: boolean
  /** Hanya ada untuk properti terpetakan. Lihat domain/slug.ts. */
  readonly slug?: string | undefined
  readonly name: string
  readonly city?: string | undefined
  readonly address?: string | undefined
  readonly starRating?: number | undefined
  readonly amenities: readonly string[]
  readonly coordinates?: { readonly latitude: number; readonly longitude: number } | undefined
  /** Seluruh tawaran, terurut dari termurah. Dibutuhkan FR-10. */
  readonly offers: readonly Offer[]
  readonly suppliers: readonly SupplierCode[]
}

export interface MergeResult {
  readonly properties: readonly MergedProperty[]
  /** Properti belum terpetakan yang ditemui, untuk antrian pemetaan. */
  readonly unmapped: readonly UnmappedSighting[]
}

export interface UnmappedSighting {
  readonly supplierId: SupplierCode
  readonly supplierPropertyId: string
  readonly name: string
  readonly address?: string | undefined
  readonly city?: string | undefined
  readonly latitude?: number | undefined
  readonly longitude?: number | undefined
}

/**
 * Menggabungkan jawaban mentah beberapa supplier menjadi satu daftar.
 *
 * Deduplikasi memakai tabel pemetaan dari Step 12b, dibaca dari snapshot di
 * memori — bukan dari basis data. Jalur ini dipanggil untuk setiap properti
 * dari setiap supplier, ratusan kali per pencarian.
 */
export function mergeResults(
  results: readonly SupplierSearchResult[],
  catalog: PropertyLookup,
): MergeResult {
  const byRef = new Map<string, MergedProperty>()
  const unmapped: UnmappedSighting[] = []

  for (const result of results) {
    for (const property of result.properties) {
      const offers = offersOf(result.supplier, property)
      if (offers.length === 0) continue

      const propertyId = catalog.propertyId(result.supplier, property.supplierPropertyId)
      const known = propertyId === undefined ? undefined : catalog.property(propertyId)

      if (known === undefined) {
        unmapped.push(sightingOf(result.supplier, property))
      }

      const ref = known?.id ?? unmappedRef(result.supplier, property.supplierPropertyId)
      const existing = byRef.get(ref)

      byRef.set(
        ref,
        existing === undefined
          ? firstEntry({ ref, known, property, supplier: result.supplier, offers })
          : mergeInto(existing, result.supplier, offers),
      )
    }
  }

  return {
    properties: [...byRef.values()].map(sortOffers),
    unmapped,
  }
}

/**
 * Pengenal untuk properti yang belum terpetakan.
 *
 * Sengaja diberi awalan yang jelas dan sengaja TIDAK berbentuk slug. Pengenal
 * ini berubah begitu pemetaannya ada, jadi apa pun yang menyimpannya sebagai
 * tautan permanen akan rusak — dan bentuk yang jelas-jelas bukan slug membuat
 * kesalahan itu terlihat saat ditulis, bukan berbulan-bulan kemudian.
 */
export function unmappedRef(supplier: SupplierCode, supplierPropertyId: string): string {
  return `unmapped:${supplier}:${supplierPropertyId}`
}

interface FirstEntry {
  readonly ref: string
  readonly known: Property | undefined
  readonly property: SupplierProperty
  readonly supplier: SupplierCode
  readonly offers: readonly Offer[]
}

function firstEntry({ ref, known, property, supplier, offers }: FirstEntry): MergedProperty {
  if (known !== undefined) {
    // Nama, alamat, dan koordinat diambil dari KATALOG, bukan dari supplier.
    // Supplier menyebut hotel yang sama dengan ejaan berbeda-beda; menampilkan
    // ejaan supplier yang kebetulan menjawab lebih dulu membuat nama hotel
    // berubah-ubah antar pencarian.
    return {
      ref,
      mapped: true,
      slug: known.slug,
      name: known.name,
      city: known.city,
      address: known.address,
      starRating: known.starRating,
      amenities: known.amenities,
      coordinates: { latitude: known.latitude, longitude: known.longitude },
      offers: [...offers],
      suppliers: [supplier],
    }
  }

  return {
    ref,
    mapped: false,
    name: property.name,
    ...(property.city === undefined ? {} : { city: property.city }),
    ...(property.address === undefined ? {} : { address: property.address }),
    ...(property.starRating === undefined ? {} : { starRating: property.starRating }),
    amenities: property.amenities,
    ...(property.coordinates === undefined ? {} : { coordinates: property.coordinates }),
    offers: [...offers],
    suppliers: [supplier],
  }
}

function mergeInto(
  existing: MergedProperty,
  supplier: SupplierCode,
  offers: readonly Offer[],
): MergedProperty {
  return {
    ...existing,
    offers: [...existing.offers, ...offers],
    suppliers: existing.suppliers.includes(supplier)
      ? existing.suppliers
      : [...existing.suppliers, supplier],
  }
}

function sortOffers(property: MergedProperty): MergedProperty {
  return {
    ...property,
    // Termurah lebih dulu, lalu supplier dan pengenal sebagai pemutus supaya
    // urutannya tetap antar pencarian meski harganya sama persis.
    offers: [...property.offers].sort(
      (a, b) =>
        a.supplierTotal.amountMinor - b.supplierTotal.amountMinor ||
        a.supplier.localeCompare(b.supplier) ||
        a.supplierRatePlanId.localeCompare(b.supplierRatePlanId),
    ),
  }
}

function offersOf(supplier: SupplierCode, property: SupplierProperty): readonly Offer[] {
  return property.roomTypes.flatMap((roomType) =>
    roomType.ratePlans
      // Rate plan tanpa unit tersisa bukan tawaran. Menampilkannya berarti
      // menjanjikan kamar yang tidak ada.
      .filter((ratePlan) => ratePlan.availability.unitsLeft > 0)
      .map((ratePlan) => ({
        supplier,
        supplierPropertyId: property.supplierPropertyId,
        supplierRatePlanId: ratePlan.supplierRatePlanId,
        roomTypeName: roomType.name,
        ratePlanName: ratePlan.name,
        supplierTotal: ratePlan.total,
        refundable: ratePlan.cancellationPolicy.refundable,
        ...(ratePlan.cancellationPolicy.refundable &&
        ratePlan.cancellationPolicy.freeCancellationDays !== undefined
          ? { freeCancellationDays: ratePlan.cancellationPolicy.freeCancellationDays }
          : {}),
        breakfastIncluded: ratePlan.breakfastIncluded,
        unitsLeft: ratePlan.availability.unitsLeft,
      })),
  )
}

function sightingOf(supplier: SupplierCode, property: SupplierProperty): UnmappedSighting {
  return {
    supplierId: supplier,
    supplierPropertyId: property.supplierPropertyId,
    name: property.name,
    ...(property.address === undefined ? {} : { address: property.address }),
    ...(property.city === undefined ? {} : { city: property.city }),
    ...(property.coordinates === undefined
      ? {}
      : { latitude: property.coordinates.latitude, longitude: property.coordinates.longitude }),
  }
}

/**
 * Penyaringan.
 *
 * Diterapkan SETELAH penggabungan, bukan sebelumnya. Properti yang satu
 * supplier-nya menawarkan tarif tanpa sarapan dan supplier lain dengan
 * sarapan harus tetap muncul ketika pengguna menyaring "dengan sarapan" —
 * yang disaring adalah tawarannya, dan propertinya bertahan selama masih ada
 * satu tawaran yang lolos.
 */
export function applyFilters(
  properties: readonly MergedProperty[],
  criteria: SearchCriteria,
): readonly MergedProperty[] {
  return properties
    .filter((property) => matchesProperty(property, criteria))
    .map((property) => ({
      ...property,
      offers: property.offers.filter((offer) => matchesOffer(offer, criteria)),
    }))
    .filter((property) => property.offers.length > 0)
    .map((property) => ({
      ...property,
      // Daftar supplier ikut menyusut bersama tawarannya. Metadata yang
      // menyebut supplier yang seluruh tawarannya tersaring adalah metadata
      // yang berbohong.
      suppliers: [...new Set(property.offers.map((offer) => offer.supplier))],
    }))
}

function matchesProperty(property: MergedProperty, criteria: SearchCriteria): boolean {
  if (criteria.minStarRating !== undefined && (property.starRating ?? 0) < criteria.minStarRating) {
    return false
  }

  if (criteria.amenities.length > 0) {
    const owned = new Set(property.amenities.map((item) => item.toLowerCase()))
    if (!criteria.amenities.every((wanted) => owned.has(wanted))) return false
  }

  return true
}

function matchesOffer(offer: Offer, criteria: SearchCriteria): boolean {
  if (criteria.refundableOnly && !offer.refundable) return false
  if (criteria.breakfastIncluded && !offer.breakfastIncluded) return false

  return true
}

/**
 * Yang dibutuhkan pengurutan dari sebuah properti.
 *
 * Generik, bukan terikat [MergedProperty], karena yang diurutkan sebenarnya
 * adalah properti yang SUDAH berharga jual — dan harga jual belum ada saat
 * penggabungan. Mengurutkan dua kali, sekali pada harga supplier lalu sekali
 * lagi pada harga jual, akan menghasilkan urutan yang berbeda ketika markup
 * antar supplier berbeda.
 */
export interface Sortable {
  readonly name: string
  readonly mapped: boolean
  readonly starRating?: number | undefined
}

/**
 * Pengurutan.
 *
 * `relevance` bukan penampung kosong: ia mengurutkan menurut bintang lalu
 * harga, dan properti terpetakan didahulukan atas yang belum. Yang terakhir
 * itu keputusan produk, bukan teknis — properti terpetakan punya nama
 * kanonik, foto, dan halaman yang dapat dibuka, sementara yang belum hanya
 * punya apa yang dikatakan supplier.
 */
export function sortProperties<T extends Sortable>(
  properties: readonly T[],
  criteria: SearchCriteria,
  lowestOf: (property: T) => number,
): readonly T[] {
  const byName = (a: T, b: T) => a.name.localeCompare(b.name)

  const comparators: Record<SearchCriteria['sort'], (a: T, b: T) => number> = {
    price: (a, b) => lowestOf(a) - lowestOf(b) || byName(a, b),
    rating: (a, b) => (b.starRating ?? 0) - (a.starRating ?? 0) || lowestOf(a) - lowestOf(b),
    relevance: (a, b) =>
      Number(b.mapped) - Number(a.mapped) ||
      (b.starRating ?? 0) - (a.starRating ?? 0) ||
      lowestOf(a) - lowestOf(b),
  }

  return [...properties].sort(comparators[criteria.sort])
}
