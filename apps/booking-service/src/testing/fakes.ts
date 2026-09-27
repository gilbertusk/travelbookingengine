import { money, type Money } from '@tbe/money'
import { createLogger } from '@tbe/shared-kernel'
import type {
  AcquireOutcome,
  BookingDeps,
  HoldClaim,
  HoldEntry,
  HoldStore,
  Pricing,
  PricingRequest,
  RatePlanStay,
  SupplierAnswer,
  SupplierHold,
  SupplierQuotes,
} from '../application/ports.js'
import type { SellQuote } from '../domain/sell-price.js'
import { createPrismaBookingRepository } from '../infrastructure/prisma-booking-repository.js'
import { memoryBookingDb, type MemoryBookingDb } from './memory-db.js'

/**
 * Palsuan untuk use case Step 17.
 *
 * Seperti Step 16 dan Step 18: palsuan MENIRU sifat sungguhan yang diandalkan
 * kode, dan untuk sifat yang paling penting — atomisitas hold lokal — ada
 * palsuan TANDINGAN yang sengaja tidak memilikinya. Uji "seratus permintaan,
 * sepuluh kursi" harus gagal pada tandingannya; kalau tidak, ujinya hampa.
 *
 * Bahwa Redis sungguhan menjalankan skrip Lua secara atomik dibuktikan
 * terpisah, terhadap Redis sungguhan, di tests/integration.
 */

interface Slots {
  readonly members: Map<string, Set<string>>
  readonly capacity: Map<string, number>
  readonly locks: Map<string, { slot: string; until: number }>
}

export interface MemoryHoldStore extends HoldStore {
  readonly slots: Slots
  /** Meniru kunci waktu yang hilang (Redis dimulai ulang, atau kedaluwarsa). */
  dropLock(bookingId: string): void
  held(slot: string): number
}

/**
 * Mode atomik: pemeriksaan dan penambahan dalam satu langkah sinkron,
 * tanpa titik tunggu di antaranya — meniru skrip Lua. Mode `racy`: titik
 * tunggu DI ANTARA membaca jumlah kursi dan menambah anggota — meniru
 * SCARD lalu SADD dari klien.
 */
async function acquire(
  slots: Slots,
  membersOf: (slot: string) => Set<string>,
  claim: HoldClaim,
  racy: boolean,
): Promise<AcquireOutcome> {
  const members = membersOf(claim.slot)
  if (members.has(claim.bookingId)) return 'already_held'

  const capacity = slots.capacity.get(claim.slot) ?? claim.capacity
  slots.capacity.set(claim.slot, capacity)
  const taken = members.size

  if (racy) await Promise.resolve()
  if (taken >= capacity) return 'sold_out'

  members.add(claim.bookingId)
  slots.locks.set(claim.bookingId, { slot: claim.slot, until: claim.until.getTime() })
  await Promise.resolve()
  return 'held'
}

function buildHoldStore(racy: boolean): MemoryHoldStore {
  const slots: Slots = { members: new Map(), capacity: new Map(), locks: new Map() }
  const membersOf = (slot: string): Set<string> => {
    const existing = slots.members.get(slot)
    if (existing !== undefined) return existing
    const created = new Set<string>()
    slots.members.set(slot, created)
    return created
  }

  return {
    slots,
    dropLock: (bookingId) => {
      slots.locks.delete(bookingId)
    },
    held: (slot) => membersOf(slot).size,

    acquire: async (claim) => await acquire(slots, membersOf, claim, racy),

    async shorten(bookingId, until) {
      const lock = slots.locks.get(bookingId)
      if (lock !== undefined && until.getTime() < lock.until) lock.until = until.getTime()
      await Promise.resolve()
    },

    async release(entry: HoldEntry) {
      const removed = membersOf(entry.slot).delete(entry.bookingId)
      slots.locks.delete(entry.bookingId)
      await Promise.resolve()
      return removed
    },

    async orphans(limit) {
      await Promise.resolve()
      const found: HoldEntry[] = []
      for (const [slot, members] of slots.members) {
        for (const bookingId of members) {
          if (!slots.locks.has(bookingId)) found.push({ bookingId, slot })
        }
      }
      return found.slice(0, limit)
    },
  }
}

export function memoryHoldStore(): MemoryHoldStore {
  return buildHoldStore(false)
}

/** Palsuan tandingan: periksa dulu, tunggu, baru tulis. Sengaja salah. */
export function racyHoldStore(): MemoryHoldStore {
  return buildHoldStore(true)
}

type Answer<T> = SupplierAnswer<T> | ((request: RatePlanStay) => SupplierAnswer<T>)

export interface ScriptedSuppliers extends SupplierQuotes {
  readonly priceChecks: RatePlanStay[]
  readonly holds: RatePlanStay[]
  nextPrice(answer: Answer<{ readonly total: Money }>): void
  nextHold(answer: Answer<SupplierHold>): void
  /** Harga supplier yang dijawab bila tidak ada jawaban terjadwal. */
  supplierTotal: Money
}

export function scriptedSuppliers(now: () => Date): ScriptedSuppliers {
  const prices: Answer<{ readonly total: Money }>[] = []
  const holdAnswers: Answer<SupplierHold>[] = []
  const priceChecks: RatePlanStay[] = []
  const holds: RatePlanStay[] = []
  let holdCounter = 0

  const suppliers: ScriptedSuppliers = {
    priceChecks,
    holds,
    supplierTotal: money(2_000_000, 'IDR'),
    nextPrice: (answer) => prices.push(answer),
    nextHold: (answer) => holdAnswers.push(answer),
    async priceCheck(request) {
      priceChecks.push(request)
      await Promise.resolve()
      const scripted = prices.shift()
      if (scripted === undefined) return { kind: 'ok', value: { total: suppliers.supplierTotal } }
      return typeof scripted === 'function' ? scripted(request) : scripted
    },
    async hold(request) {
      holds.push(request)
      await Promise.resolve()
      const scripted = holdAnswers.shift()
      if (scripted !== undefined)
        return typeof scripted === 'function' ? scripted(request) : scripted
      holdCounter += 1
      return {
        kind: 'ok',
        value: {
          holdRef: `sky-hold-${String(holdCounter)}`,
          expiresAt: new Date(now().getTime() + 20 * 60 * 1_000),
          total: suppliers.supplierTotal,
        },
      }
    },
  }

  return suppliers
}

/**
 * pricing-service palsuan dengan aturan tetap: markup 10%, PPN 11% dari harga
 * setelah markup, dibulatkan ke rupiah penuh. Rp 2.000.000 → Rp 2.442.000.
 */
export interface ScriptedPricing extends Pricing {
  readonly requests: PricingRequest[]
  failNext(): void
  /** Jawaban berikutnya apa adanya — termasuk yang tidak konsisten. */
  nextQuote(quote: SellQuote): void
}

export function scriptedPricing(): ScriptedPricing {
  const requests: PricingRequest[] = []
  const quotes: SellQuote[] = []
  let failing = 0

  return {
    requests,
    failNext: () => {
      failing += 1
    },
    nextQuote: (quote) => {
      quotes.push(quote)
    },
    async sellPrice(request) {
      requests.push(request)
      await Promise.resolve()
      if (failing > 0) {
        failing -= 1
        return undefined
      }
      return quotes.shift() ?? sellQuoteFor(request.supplierTotal)
    },
  }
}

export function sellQuoteFor(supplierTotal: Money): SellQuote {
  const base = supplierTotal.amountMinor
  const markup = Math.round(base / 10)
  const tax = Math.round(((base + markup) * 11) / 100)
  const currency = supplierTotal.currency

  return {
    base: supplierTotal,
    markup: money(markup, currency),
    tax: money(tax, currency),
    total: money(base + markup + tax, currency),
    taxName: 'PPN 11%',
  }
}

export interface Harness {
  readonly deps: BookingDeps
  readonly db: MemoryBookingDb
  readonly holds: MemoryHoldStore
  readonly suppliers: ScriptedSuppliers
  readonly pricing: ScriptedPricing
  /** Memajukan jam palsu. */
  advance(ms: number): void
  now(): Date
}

export const HOLD_DURATION_MS = 15 * 60 * 1_000

export function harness(options: { holds?: MemoryHoldStore } = {}): Harness {
  let now = new Date('2026-10-01T03:00:00.000Z')
  let ids = 0
  const db = memoryBookingDb()
  const holds = options.holds ?? memoryHoldStore()
  const suppliers = scriptedSuppliers(() => now)
  const pricing = scriptedPricing()

  const deps: BookingDeps = {
    bookings: createPrismaBookingRepository(db),
    suppliers,
    pricing,
    holds,
    clock: { now: () => now },
    ids: {
      next: () => {
        ids += 1
        return `00000000-0000-4000-8000-${String(ids).padStart(12, '0')}`
      },
    },
    holdPolicy: { durationMs: HOLD_DURATION_MS, sweepBatch: 50 },
    logger: createLogger({ serviceName: 'booking-service-test', level: 'silent' }),
  }

  return {
    deps,
    db,
    holds,
    suppliers,
    pricing,
    advance: (ms) => {
      now = new Date(now.getTime() + ms)
    },
    now: () => now,
  }
}

export const USER = '7b9e2d14-1f3a-4e5c-8d6b-2a1c0f9e8d7c'
export const OTHER_USER = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'

/** Permintaan price check contoh. Harga yang ditampilkan = harga jual dari Rp 2.000.000. */
export function priceCheckRequest(
  overrides: Partial<{ key: string; userId: string; displayed: number }> = {},
) {
  return {
    userId: overrides.userId ?? USER,
    idempotencyKey: overrides.key ?? 'req-2026-10-01-0001',
    supplier: 'SKY' as const,
    propertyId: 'prop-bali-001',
    city: 'Denpasar',
    ratePlanRef: 'SKY-RP-DLX-BB',
    checkIn: '2026-11-10',
    checkOut: '2026-11-12',
    guest: { fullName: 'Sari Wulandari', email: 'sari@example.com', count: 2 },
    displayedTotal: money(overrides.displayed ?? 2_442_000, 'IDR'),
  }
}
