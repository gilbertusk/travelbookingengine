import type { Money } from '@tbe/money'

/**
 * Bahan dan hasil e-voucher (FR-24).
 *
 * Voucher adalah bukti pemesanan yang dibawa tamu ke meja resepsionis. Yang
 * sah di sana hanyalah booking reference dari SUPPLIER — pengenal internal
 * kita tidak berarti apa pun bagi properti — jadi voucher tanpa reference itu
 * tidak boleh terbit sama sekali.
 */

export const SUPPLIER_CODES = ['SKY', 'NOVA', 'ORBIT', 'LUNA', 'ZEPH'] as const
export type SupplierCode = (typeof SUPPLIER_CODES)[number]

export type CancellationPolicy =
  | { readonly refundable: false }
  | { readonly refundable: true; readonly freeCancellationDays?: number }

export interface OfferTerms {
  readonly roomTypeName: string
  readonly ratePlanName: string
  readonly breakfastIncluded: boolean
  readonly cancellationPolicy: CancellationPolicy
}

export interface PriceLine {
  readonly kind: 'room_night' | 'tax' | 'fee'
  readonly description: string
  readonly amount: Money
}

/** Pemesanan sebagaimana dijawab booking-service. */
export interface VoucherSource {
  readonly bookingId: string
  readonly userId: string
  readonly status: string
  readonly supplier: SupplierCode
  readonly supplierRef: string | null
  /** Waktu transisi ke CONFIRMED — titik awal pengukuran M7. */
  readonly confirmedAt: Date | null
  readonly supplierPropertyId: string
  /** Tanggal lokal properti, YYYY-MM-DD. Tidak pernah dikonversi zona. */
  readonly checkIn: string
  readonly checkOut: string
  readonly guestCount: number
  readonly leadGuestName: string
  readonly total: Money
  readonly lines: readonly PriceLine[]
  /** `null` hanya untuk pemesanan sebelum Step 23. */
  readonly terms: OfferTerms | null
}

/** Properti kanonik dari katalog search-service. */
export interface VoucherProperty {
  readonly name: string
  readonly address: string
  readonly city: string
  readonly phone?: string | undefined
  readonly email?: string | undefined
}

/** Voucher yang sudah terbit. Metadata saja; berkasnya di penyimpanan objek. */
export interface Voucher {
  readonly id: string
  readonly bookingId: string
  /** Pemilik pemesanan saat voucher terbit. Dasar pemeriksaan kepemilikan. */
  readonly userId: string
  readonly objectKey: string
  readonly sizeBytes: number
  readonly issuedAt: Date
  readonly confirmedAt: Date
}

/** Selisih konfirmasi sampai terbit, dalam milidetik. Tidak pernah negatif. */
export function issueLatencyMs(voucher: Pick<Voucher, 'issuedAt' | 'confirmedAt'>): number {
  return Math.max(0, voucher.issuedAt.getTime() - voucher.confirmedAt.getTime())
}
