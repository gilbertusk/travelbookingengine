/**
 * Fakta yang dibaca analitik dari peristiwa Kafka (Step 27).
 *
 * Bentuk ini milik analitik, bukan salinan kontrak di packages/event-contracts.
 * Lapisan messaging menerjemahkan pesan kontrak menjadi fakta, dan domain hanya
 * tahu fakta — kontrak dapat menambah bidang tanpa menyentuh satu baris pun di
 * sini, dan uji domain tidak perlu menyusun amplop pesan.
 */

export const SUPPLIER_CODES = ['SKY', 'NOVA', 'ORBIT', 'LUNA', 'ZEPH'] as const
export type SupplierCode = (typeof SUPPLIER_CODES)[number]

export type AnalyticsFact =
  | {
      readonly kind: 'search'
      readonly city: string
      readonly checkIn: string
      readonly checkOut: string
      readonly resultCount: number
      readonly latencyMs: number
      readonly source: 'cache' | 'live' | 'partial_cache'
      readonly responded: readonly SupplierCode[]
      readonly timedOut: readonly SupplierCode[]
      readonly unavailable: readonly SupplierCode[]
    }
  | {
      readonly kind: 'booking_created'
      readonly bookingId: string
      readonly supplier: SupplierCode
    }
  | { readonly kind: 'booking_held'; readonly bookingId: string }
  | { readonly kind: 'price_changed'; readonly bookingId: string }
  | {
      readonly kind: 'booking_confirmed'
      readonly bookingId: string
      readonly supplier: SupplierCode
    }
  | {
      readonly kind: 'booking_failed'
      readonly bookingId: string
      readonly stage: string
      readonly reason: string
      readonly requiresManualReview: boolean
    }
  | { readonly kind: 'booking_cancelled'; readonly bookingId: string; readonly reason: string }
  | { readonly kind: 'payment_succeeded'; readonly bookingId: string }
  | { readonly kind: 'payment_failed'; readonly bookingId: string; readonly reason: string }
  | { readonly kind: 'supplier_degraded'; readonly supplier: SupplierCode }
  | {
      readonly kind: 'supplier_confirm'
      readonly supplier: SupplierCode
      readonly outcome: 'confirmed' | 'rejected' | 'uncertain'
    }
  /** Peristiwa lain: hanya dihitung per jenis — bukti bahwa SELURUH topik dibaca. */
  | { readonly kind: 'other' }

/** Fakta yang menyebut pemesanan tetapi tidak menyebut suppliernya. */
export type NeedsSupplier = Extract<AnalyticsFact, { kind: 'price_changed' | 'booking_failed' }>

export function needsSupplier(fact: AnalyticsFact): fact is NeedsSupplier {
  return fact.kind === 'price_changed' || fact.kind === 'booking_failed'
}
