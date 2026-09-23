import type { Booking, Hold } from '../domain/booking.js'
import type { Property, RatePlan, RoomType } from '../domain/catalog.js'
import type { SupplierCode } from '../domain/supplier.js'

export interface Clock {
  now(): number
}

export interface CatalogReader {
  propertiesInCity(city: string): readonly Property[]
  property(propertyId: string): Property | undefined
  roomTypesOf(propertyId: string): readonly RoomType[]
  ratePlansOf(roomTypeId: string): readonly RatePlan[]
  ratePlan(ratePlanId: string): RatePlan | undefined
  allProperties(): readonly Property[]
  allRatePlans(): readonly RatePlan[]
}

/**
 * Pemetaan dua arah antara pengenal internal dan pengenal versi supplier.
 * Port, bukan detail: lapisan HTTP hanya perlu tahu bahwa pemetaan itu ada,
 * bukan bagaimana ia dibangun.
 */
export interface RefIndex {
  rateRef(supplier: SupplierCode, ratePlanId: string): string
  propertyRef(supplier: SupplierCode, propertyId: string): string
  ratePlanIdOf(supplier: SupplierCode, rateRef: string): string | undefined
  propertyIdOf(supplier: SupplierCode, propertyRef: string): string | undefined
}

/**
 * Menyimpan hanya selisih dari keadaan dasar: unit yang sedang ditahan atau
 * sudah terjual, hold yang aktif, booking, dan harga yang sudah bergeser.
 * Ketersediaan dasar dan harga dasar tetap dihitung dari fungsi deterministik.
 */
export interface InventoryStore {
  consumedUnits(ratePlanId: string, date: string): number
  consume(ratePlanId: string, nights: readonly string[], units: number): void
  release(ratePlanId: string, nights: readonly string[], units: number): void

  putHold(hold: Hold): void
  hold(ref: string): Hold | undefined
  removeHold(ref: string): void
  expiredHolds(nowMs: number): readonly Hold[]

  putBooking(booking: Booking): void
  booking(ref: string): Booking | undefined
  bookingByIdempotencyKey(supplier: SupplierCode, key: string): Booking | undefined

  driftedPrice(key: string): number | undefined
  setDriftedPrice(key: string, priceMinorIdr: number): void

  reset(): void
}

export interface OperationDeps {
  readonly catalog: CatalogReader
  readonly store: InventoryStore
  readonly clock: Clock
  /** Sumber keacakan untuk pergeseran harga; dapat diganti pada pengujian. */
  readonly random: () => number
  /** Pembuat pengenal hold dan booking; dapat diganti pada pengujian. */
  readonly newRef: (prefix: string) => string
}
