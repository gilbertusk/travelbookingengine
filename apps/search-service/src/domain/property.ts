import { z } from 'zod'

/**
 * Properti kanonik.
 *
 * Data STATIS saja. Tidak ada harga, tidak ada ketersediaan, tidak ada rate
 * plan. Batas itu ditegakkan `pnpm verify:catalog` pada skema, dan dijaga di
 * sini oleh bentuk tipenya: bidang yang tidak ada tidak dapat diisi diam-diam.
 */

export const propertySchema = z.object({
  id: z.uuid(),
  /** Permanen. Lihat domain/slug.ts. */
  slug: z.string().min(1),
  name: z.string().min(1),
  normalizedName: z.string().min(1),
  address: z.string(),
  city: z.string().min(1),
  countryCode: z.string().length(2),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  /**
   * Zona waktu IANA. Dibutuhkan Step 25 untuk menghitung tenggat pembatalan
   * dengan zona waktu hotel, bukan zona waktu peramban pemesan.
   */
  timezone: z.string().min(1),
  starRating: z.number().int().min(0).max(5),
  amenities: z.array(z.string()),
  description: z.string().optional(),
  photos: z.array(z.string()),
  /**
   * Kontak properti untuk e-voucher (Step 23). Opsional: properti yang dibuat
   * operator dari antrian belum terpetakan belum tentu punya kontak, dan
   * voucher-nya menyebut tidak ada kontak alih-alih menampilkan string kosong.
   */
  phone: z.string().min(1).optional(),
  email: z.string().min(1).optional(),
})

export type Property = z.infer<typeof propertySchema>

/**
 * Properti yang dikembalikan supplier tetapi belum dikenali.
 *
 * Tetap ditampilkan di hasil pencarian apa adanya. Yang tidak dimilikinya:
 * slug. Tanpa pemetaan tidak ada identitas internal, dan tanpa identitas
 * internal tidak ada URL yang stabil untuk diindeks.
 */
export interface UnmappedProperty {
  readonly supplierId: string
  readonly supplierPropertyId: string
  readonly rawName: string
  readonly rawAddress?: string | undefined
  readonly rawCity?: string | undefined
  readonly latitude?: number | undefined
  readonly longitude?: number | undefined
  readonly occurrences: number
  readonly firstSeenAt: string
  readonly lastSeenAt: string
}

/**
 * Bagaimana sebuah properti muncul di hasil pencarian.
 *
 * Union, bukan satu bentuk dengan bidang opsional. Properti belum terpetakan
 * TIDAK punya slug, dan tipe yang memberinya slug opsional akan menggoda
 * pemanggil menuliskan `property.slug ?? property.id` — yang menghasilkan URL
 * yang berubah begitu pemetaannya ada.
 */
export type SearchProperty =
  | { readonly kind: 'mapped'; readonly property: Property }
  | {
      readonly kind: 'unmapped'
      readonly supplierId: string
      readonly supplierPropertyId: string
      readonly name: string
      readonly address?: string | undefined
      readonly city?: string | undefined
      readonly latitude?: number | undefined
      readonly longitude?: number | undefined
    }

export interface RawSupplierProperty {
  readonly supplierId: string
  readonly supplierPropertyId: string
  readonly name: string
  readonly address?: string | undefined
  readonly city?: string | undefined
  readonly latitude?: number | undefined
  readonly longitude?: number | undefined
}
