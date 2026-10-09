import { money, type Money } from '@tbe/money'
import { createLogger, type Logger } from '@tbe/shared-kernel'
import type {
  AcquireOutcome,
  BookingDeps,
  SagaPolicy,
  HoldClaim,
  HoldEntry,
  HoldStore,
  Payments,
  PaymentStart,
  PaymentStartRequest,
  Pricing,
  PricingRequest,
  PropertyDirectory,
  RatePlanStay,
  SupplierAnswer,
  SupplierHold,
  SupplierPrice,
  SupplierQuotes,
  TimeZoneAnswer,
} from '../application/ports.js'
import type { CancellationPolicy } from '../domain/offer-terms.js'
import type { SellQuote } from '../domain/sell-price.js'
import { createPrismaBookingRepository } from '../infrastructure/prisma-booking-repository.js'
import { createPrismaSagaStore } from '../infrastructure/prisma-saga-store.js'
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
/** Lebar jendela balapan palsuan tandingan. */
const RACE_WINDOW_MS = 20

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

  // Jendela balapan selebar beberapa milidetik, bukan satu mikrotask. Step
  // 19 menambah penulisan saga SEBELUM hold lokal, dan penulisan itu
  // menyerialkan permintaan sehingga jendela satu mikrotask tidak pernah
  // tumpang tindih — tandingan yang tidak pernah berbalapan membuat uji
  // "seratus permintaan, sepuluh kursi" hampa lagi. Satu giliran makrotask
  // pun ternyata tidak cukup di bawah beban `pnpm test` seluruh repo; jeda
  // beberapa milidetik meniru perjalanan jaringan SCARD lalu SADD dari klien.
  if (racy) await new Promise((resolve) => setTimeout(resolve, RACE_WINDOW_MS))
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
  nextPrice(answer: Answer<SupplierPrice>): void
  nextHold(answer: Answer<SupplierHold>): void
  /** Harga supplier yang dijawab bila tidak ada jawaban terjadwal. */
  supplierTotal: Money
  /** Kebijakan pembatalan yang dijawab price check bila tidak ada jawaban terjadwal. */
  supplierPolicy: CancellationPolicy
}

export function scriptedSuppliers(now: () => Date): ScriptedSuppliers {
  const prices: Answer<SupplierPrice>[] = []
  const holdAnswers: Answer<SupplierHold>[] = []
  const priceChecks: RatePlanStay[] = []
  const holds: RatePlanStay[] = []
  let holdCounter = 0

  const suppliers: ScriptedSuppliers = {
    priceChecks,
    holds,
    supplierTotal: money(2_000_000, 'IDR'),
    supplierPolicy: { refundable: true, freeCancellationDays: 3 },
    nextPrice: (answer) => prices.push(answer),
    nextHold: (answer) => holdAnswers.push(answer),
    async priceCheck(request) {
      priceChecks.push(request)
      await Promise.resolve()
      const scripted = prices.shift()
      if (scripted === undefined) {
        return {
          kind: 'ok',
          value: { total: suppliers.supplierTotal, policy: suppliers.supplierPolicy },
        }
      }
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

/** payment-service palsuan: menjawab `started` kecuali dijadwalkan lain. */
export interface ScriptedPayments extends Payments {
  readonly requests: PaymentStartRequest[]
  next(answer: PaymentStart): void
}

export function scriptedPayments(): ScriptedPayments {
  const requests: PaymentStartRequest[] = []
  const answers: PaymentStart[] = []

  return {
    requests,
    next: (answer) => {
      answers.push(answer)
    },
    async start(request) {
      requests.push(request)
      await Promise.resolve()
      return (
        answers.shift() ?? {
          kind: 'started',
          paymentId: `pay-${request.bookingId}`,
          redirectUrl: `https://app.sandbox.midtrans.example/snap/v4/redirection/${request.bookingId}`,
          snapToken: `snap-${request.bookingId}`,
        }
      )
    },
  }
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

/** Katalog palsuan: setiap properti di Bali (UTC+8) kecuali dijadwalkan lain. */
export interface ScriptedProperties extends PropertyDirectory {
  answer: TimeZoneAnswer
  readonly lookups: string[]
}

export function scriptedProperties(): ScriptedProperties {
  const lookups: string[] = []
  const properties: ScriptedProperties = {
    answer: { kind: 'found', timeZone: 'Asia/Makassar' },
    lookups,
    async timeZoneOf(supplier, propertyId) {
      lookups.push(`${supplier}/${propertyId}`)
      await Promise.resolve()
      return properties.answer
    },
  }

  return properties
}

export interface Harness {
  readonly deps: BookingDeps
  readonly properties: ScriptedProperties
  readonly db: MemoryBookingDb
  readonly holds: MemoryHoldStore
  readonly suppliers: ScriptedSuppliers
  readonly pricing: ScriptedPricing
  /** Memajukan jam palsu. */
  advance(ms: number): void
  now(): Date
}

export const HOLD_DURATION_MS = 15 * 60 * 1_000

/** Kebijakan saga di uji: angka bulat supaya batas waktu mudah dilompati jam palsu. */
export const SAGA_POLICY: SagaPolicy = {
  leaseMs: 60_000,
  confirmTimeoutMs: 10 * 60_000,
  awaitRefundTimeoutMs: 15 * 60_000,
  compensationRetry: { maxAttempts: 3, retryDelayMs: 30_000 },
  sweepBatch: 50,
}

export function harness(
  options: {
    holds?: MemoryHoldStore
    logger?: Logger
    db?: MemoryBookingDb
    /** Jam bersama — dipakai dunia saga yang "memulai ulang proses" di atas jam yang sama. */
    clock?: { value: Date }
  } = {},
): Harness {
  const clock = options.clock ?? { value: new Date('2026-10-01T03:00:00.000Z') }
  let ids = 0
  const db = options.db ?? memoryBookingDb()
  const holds = options.holds ?? memoryHoldStore()
  const suppliers = scriptedSuppliers(() => clock.value)
  const pricing = scriptedPricing()
  const properties = scriptedProperties()

  const deps: BookingDeps = {
    bookings: createPrismaBookingRepository(db),
    sagas: createPrismaSagaStore(db),
    sagaPolicy: SAGA_POLICY,
    suppliers,
    pricing,
    properties,
    holds,
    clock: { now: () => clock.value },
    ids: {
      next: () => {
        ids += 1
        return `00000000-0000-4000-8000-${String(ids).padStart(12, '0')}`
      },
    },
    holdPolicy: { durationMs: HOLD_DURATION_MS, sweepBatch: 50 },
    logger:
      options.logger ?? createLogger({ serviceName: 'booking-service-test', level: 'silent' }),
  }

  return {
    deps,
    properties,
    db,
    holds,
    suppliers,
    pricing,
    advance: (ms) => {
      clock.value = new Date(clock.value.getTime() + ms)
    },
    now: () => clock.value,
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
    offer: {
      roomTypeName: 'Deluxe King',
      ratePlanName: 'Termasuk sarapan',
      breakfastIncluded: true,
      cancellationPolicy: { refundable: true as const, freeCancellationDays: 3 },
    },
    checkIn: '2026-11-10',
    checkOut: '2026-11-12',
    guest: { fullName: 'Sari Wulandari', email: 'sari@example.com', count: 2 },
    displayedTotal: money(overrides.displayed ?? 2_442_000, 'IDR'),
  }
}

export interface LogEntry {
  readonly level: string
  readonly msg: string
  readonly [key: string]: unknown
}

/**
 * Label tingkat `error` — logger shared-kernel menuliskan label, bukan angka
 * pino. Uji "galat tingkat error" memeriksa nilai ini.
 */
export const ERROR_LEVEL = 'error'

/**
 * Logger sungguhan (pino) yang tulisannya direkam — supaya uji dapat
 * membuktikan TINGKAT log, bukan sekadar bahwa sesuatu tercatat. Step doc 19
 * menuntut kegagalan kompensasi dicatat tingkat error.
 */
export function recordingLogger(): { readonly logger: Logger; entries(): readonly LogEntry[] } {
  const lines: string[] = []
  const logger = createLogger({
    serviceName: 'booking-service-test',
    level: 'debug',
    destination: {
      write(line: string): void {
        lines.push(line)
      },
    },
  })

  return {
    logger,
    // Setiap baris pino adalah satu objek JSON dengan `level` dan `msg`.
    entries: () => lines.map((line) => JSON.parse(line) as LogEntry),
  }
}
