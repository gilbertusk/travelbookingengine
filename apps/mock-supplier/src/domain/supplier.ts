import { chance, fractionOf } from './deterministic.js'

/**
 * Lima supplier dengan watak berbeda.
 *
 * Perbedaan ini disengaja dan tidak boleh disederhanakan. Kalau kelimanya
 * berbicara protokol yang sama dengan mata uang yang sama pada kecepatan yang
 * sama, lapisan adapter pada Step 10 kehilangan alasan untuk ada, dan seluruh
 * klaim ketahanan pada README nanti tidak terbukti oleh apa pun.
 */

export const SUPPLIER_CODES = ['SKY', 'NOVA', 'ORBIT', 'LUNA', 'ZEPH'] as const
export type SupplierCode = (typeof SUPPLIER_CODES)[number]

export type SupplierCurrency = 'IDR' | 'USD'

export interface SupplierProfile {
  readonly code: SupplierCode
  readonly label: string
  readonly protocol: 'rest-json' | 'soap-xml'
  readonly currency: SupplierCurrency
  /** Bagian katalog yang dijual supplier ini. */
  readonly coverage: number
  readonly latencyMs: readonly [number, number]
  /** Peluang kegagalan bawaan, di luar yang disuntikkan lewat panel admin. */
  readonly failureRate: number
  /** Peluang harga bergeser saat price check. */
  readonly priceDriftRate: number
}

/** Kurs tetap. Nilai sungguhan tidak relevan; yang diuji adalah konversinya. */
export const IDR_PER_USD = 16_000

export const SUPPLIER_PROFILES: Readonly<Record<SupplierCode, SupplierProfile>> = {
  SKY: {
    code: 'SKY',
    label: 'SkyRooms',
    protocol: 'rest-json',
    currency: 'IDR',
    coverage: 0.9,
    latencyMs: [120, 260],
    failureRate: 0,
    priceDriftRate: 0.08,
  },
  NOVA: {
    code: 'NOVA',
    label: 'NovaStay',
    protocol: 'rest-json',
    currency: 'USD',
    coverage: 0.7,
    latencyMs: [420, 780],
    failureRate: 0.01,
    priceDriftRate: 0.12,
  },
  ORBIT: {
    code: 'ORBIT',
    label: 'OrbitBeds',
    protocol: 'soap-xml',
    currency: 'IDR',
    coverage: 0.6,
    latencyMs: [700, 1_150],
    failureRate: 0.02,
    priceDriftRate: 0.1,
  },
  LUNA: {
    code: 'LUNA',
    label: 'LunaTravel',
    protocol: 'rest-json',
    currency: 'IDR',
    coverage: 0.5,
    latencyMs: [2_400, 3_200],
    failureRate: 0.03,
    priceDriftRate: 0.09,
  },
  ZEPH: {
    code: 'ZEPH',
    label: 'Zephyr',
    protocol: 'rest-json',
    currency: 'USD',
    coverage: 0.65,
    latencyMs: [320, 520],
    failureRate: 0.15,
    priceDriftRate: 0.11,
  },
}

export function isSupplierCode(value: string): value is SupplierCode {
  return (SUPPLIER_CODES as readonly string[]).includes(value)
}

export function coversProperty(code: SupplierCode, propertyId: string): boolean {
  return chance(SUPPLIER_PROFILES[code].coverage, 'coverage', code, propertyId)
}

/**
 * Pengenal properti versi supplier. Sengaja tidak menyerupai pengenal internal
 * agar Step 12b benar-benar membutuhkan tabel pemetaan, bukan sekadar memotong
 * awalan string.
 */
export function supplierPropertyRef(code: SupplierCode, propertyId: string): string {
  return `${code.toLowerCase()}-${String(fractionOf('propRef', code, propertyId)).slice(2, 11)}`
}

export function supplierRateRef(code: SupplierCode, ratePlanId: string): string {
  return `${code.toLowerCase()}r${String(fractionOf('rateRef', code, ratePlanId)).slice(2, 13)}`
}

/**
 * Pengali harga per supplier. Supplier yang sama menjual properti yang sama
 * dengan harga berbeda — inilah yang membuat perbandingan harga pada Step 13
 * menghasilkan sesuatu.
 */
export function supplierPriceMultiplier(code: SupplierCode, ratePlanId: string): number {
  return 0.93 + fractionOf('priceMult', code, ratePlanId) * 0.22
}

/**
 * Nama properti versi supplier. Variasi penulisan ini yang membuat pencocokan
 * berbasis nama rapuh, dan karena itu Step 12b memakai tabel pemetaan.
 */
export function supplierPropertyName(code: SupplierCode, canonicalName: string): string {
  switch (code) {
    case 'SKY':
      return canonicalName
    case 'NOVA':
      return canonicalName.toUpperCase()
    case 'ORBIT':
      return `${canonicalName} (${canonicalName.split(' ')[1] ?? ''})`.trim()
    case 'LUNA':
      return `Hotel ${canonicalName}`
    case 'ZEPH':
      return canonicalName.replace(/\bResort\b/, 'Rst.').replace(/\bHotel\b/, 'Htl.')
  }
}
