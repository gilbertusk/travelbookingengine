import type { InventoryStore } from '../application/ports.js'
import type { Booking, Hold } from '../domain/booking.js'
import type { SupplierCode } from '../domain/supplier.js'

/**
 * Penyimpanan dalam memori.
 *
 * Yang disimpan hanya selisih dari keadaan dasar. Ketersediaan dan harga dasar
 * tetap dihitung dari fungsi deterministik, sehingga memori tetap kecil dan
 * keadaan awal selalu sama setelah restart.
 *
 * Dipecah menjadi dua bagian yang berdiri sendiri: buku ketersediaan, dan buku
 * pemesanan. Keduanya tidak saling tahu.
 */

interface ConsumptionLedger {
  units(ratePlanId: string, date: string): number
  adjust(ratePlanId: string, nights: readonly string[], delta: number): void
  clear(): void
}

function createConsumptionLedger(): ConsumptionLedger {
  const consumed = new Map<string, number>()
  const key = (ratePlanId: string, date: string): string => `${ratePlanId}#${date}`

  return {
    units: (ratePlanId, date) => consumed.get(key(ratePlanId, date)) ?? 0,

    adjust(ratePlanId, nights, delta) {
      for (const date of nights) {
        const entry = key(ratePlanId, date)
        const next = (consumed.get(entry) ?? 0) + delta

        if (next <= 0) consumed.delete(entry)
        else consumed.set(entry, next)
      }
    },

    clear: () => {
      consumed.clear()
    },
  }
}

interface ReservationBook {
  putHold(hold: Hold): void
  hold(ref: string): Hold | undefined
  removeHold(ref: string): void
  expiredHolds(nowMs: number): readonly Hold[]
  holds(): readonly Hold[]
  putBooking(booking: Booking): void
  booking(ref: string): Booking | undefined
  byIdempotencyKey(supplier: SupplierCode, key: string): Booking | undefined
  bookings(): readonly Booking[]
  clear(): void
}

function createReservationBook(): ReservationBook {
  const holds = new Map<string, Hold>()
  const bookings = new Map<string, Booking>()
  const byKey = new Map<string, string>()
  const keyOf = (supplier: SupplierCode, key: string): string => `${supplier}#${key}`

  return {
    putHold: (hold) => {
      holds.set(hold.ref, hold)
    },
    hold: (ref) => holds.get(ref),
    removeHold: (ref) => {
      holds.delete(ref)
    },
    expiredHolds: (nowMs) => [...holds.values()].filter((hold) => hold.expiresAtMs <= nowMs),
    holds: () => [...holds.values()],

    putBooking: (booking) => {
      bookings.set(booking.ref, booking)
      byKey.set(keyOf(booking.supplier, booking.idempotencyKey), booking.ref)
    },
    booking: (ref) => bookings.get(ref),
    byIdempotencyKey: (supplier, key) => {
      const ref = byKey.get(keyOf(supplier, key))
      return ref === undefined ? undefined : bookings.get(ref)
    },
    bookings: () => [...bookings.values()],

    clear: () => {
      holds.clear()
      bookings.clear()
      byKey.clear()
    },
  }
}

export function createMemoryStore(): InventoryStore {
  const ledger = createConsumptionLedger()
  const reservations = createReservationBook()
  const driftedPrices = new Map<string, number>()

  return {
    consumedUnits: (ratePlanId, date) => ledger.units(ratePlanId, date),
    consume: (ratePlanId, nights, units) => {
      ledger.adjust(ratePlanId, nights, units)
    },
    release: (ratePlanId, nights, units) => {
      ledger.adjust(ratePlanId, nights, -units)
    },

    putHold: (hold) => {
      reservations.putHold(hold)
    },
    hold: (ref) => reservations.hold(ref),
    removeHold: (ref) => {
      reservations.removeHold(ref)
    },
    expiredHolds: (nowMs) => reservations.expiredHolds(nowMs),
    holds: () => reservations.holds(),
    putBooking: (booking) => {
      reservations.putBooking(booking)
    },
    booking: (ref) => reservations.booking(ref),
    bookingByIdempotencyKey: (supplier, key) => reservations.byIdempotencyKey(supplier, key),
    bookings: () => reservations.bookings(),

    driftedPrice: (key) => driftedPrices.get(key),
    setDriftedPrice: (key, priceMinorIdr) => {
      driftedPrices.set(key, priceMinorIdr)
    },

    reset() {
      ledger.clear()
      reservations.clear()
      driftedPrices.clear()
    },
  }
}
