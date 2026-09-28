import type { Money } from '@tbe/money'
import { placeHold } from '../application/place-hold.js'
import { startPriceCheck } from '../application/price-check.js'
import {
  onPaymentFailed,
  onPaymentRefunded,
  onPaymentSucceeded,
} from '../application/saga/on-payment.js'
import {
  onSupplierConfirmed,
  onSupplierRejected,
  onSupplierUncertain,
} from '../application/saga/on-supplier.js'
import type { BookingDeps, SagaStore } from '../application/ports.js'
import type { Reaction } from '../application/saga/reaction.js'
import type { Booking } from '../domain/booking.js'
import type { SagaState } from '../domain/saga-state.js'
import type { OutboxRow } from '../infrastructure/booking-db.js'
import { memoryBookingDb, type MemoryBookingDb } from './memory-db.js'
import {
  harness,
  memoryHoldStore,
  priceCheckRequest,
  recordingLogger,
  USER,
  type Harness,
  type LogEntry,
  type MemoryHoldStore,
} from './fakes.js'

/**
 * Dunia uji saga: use case sungguhan, repository sungguhan, di atas basis data
 * palsuan yang meniru transaksi (memory-db.ts) dan hold store yang meniru
 * atomisitas skrip Lua (fakes.ts).
 *
 * Peristiwa dari payment-service dan supplier-service dikirim dengan eventId
 * yang dapat diulang — pengiriman ulang pesan yang SAMA adalah pesan dengan
 * eventId yang sama, dan itulah yang diuji "dikonsumsi dua kali".
 *
 * `restart()` meniru proses yang mati lalu hidup lagi: dunia BARU — dependensi
 * baru, tanpa satu pun keadaan di memori proses lama — di atas basis data dan
 * Redis yang SAMA.
 */

export const PAYMENT_ID = 'c2d4e6f8-0a1b-4c3d-8e5f-6a7b8c9d0e1f'
export const OTHER_PAYMENT_ID = 'd3e5f7a9-1b2c-4d4e-9f60-7b8c9d0e1f2a'
export const REFUND_ID = 'e1f2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a5b'
export const SUPPLIER_REF = 'SKY-BK-778812'

export interface SagaWorld extends Harness {
  logs(): readonly LogEntry[]
  outbox(): readonly OutboxRow[]
  /** Jenis pesan di outbox untuk satu pemesanan, dalam urutan terbit. */
  sent(bookingId: string): readonly string[]
  saga(bookingId: string): Promise<SagaState | undefined>
  booking(bookingId: string): Promise<Booking>
  /** Pemesanan yang sudah price check dan hold, lewat use case sungguhan. */
  held(key?: string): Promise<Booking>
  /** Pemesanan yang sudah dibayar dan menunggu konfirmasi supplier. */
  paid(key?: string): Promise<Booking>
  eventId(label: string): string
  paymentSucceeded(
    booking: Booking,
    options?: { paymentId?: string; eventId?: string; amount?: Money },
  ): Promise<Reaction>
  paymentFailed(booking: Booking, eventId?: string): Promise<Reaction>
  paymentRefunded(
    booking: Booking,
    options?: { eventId?: string; amount?: Money; paymentId?: string },
  ): Promise<Reaction>
  supplierConfirmed(
    booking: Booking,
    options?: { eventId?: string; supplierRef?: string },
  ): Promise<Reaction>
  supplierRejected(booking: Booking, eventId?: string): Promise<Reaction>
  supplierUncertain(booking: Booking, eventId?: string): Promise<Reaction>
  /** Proses baru di atas basis data dan Redis yang sama. */
  restart(): SagaWorld
}

interface Shared {
  readonly db: MemoryBookingDb
  readonly holds: MemoryHoldStore
  readonly clock: { value: Date }
  /** Nomor pesan berikutnya — milik dunia bersama, bukan proses. */
  readonly nextEvent: () => number
}

export interface WorldOptions {
  readonly holds?: MemoryHoldStore
  /** Membungkus penyimpan saga proses PERTAMA saja — proses hasil restart() memakai yang asli. */
  readonly wrapSagas?: (store: SagaStore) => SagaStore
}

export function sagaWorld(options: WorldOptions = {}): SagaWorld {
  const shared = {
    db: memoryBookingDb(),
    holds: options.holds ?? memoryHoldStore(),
    clock: { value: new Date('2026-10-01T03:00:00.000Z') },
    nextEvent: counter(),
  }

  return build(shared, options.wrapSagas)
}

function build(shared: Shared, wrapSagas?: (store: SagaStore) => SagaStore): SagaWorld {
  const log = recordingLogger()
  const base = harness({
    db: shared.db,
    holds: shared.holds,
    logger: log.logger,
    clock: shared.clock,
  })
  const world =
    wrapSagas === undefined
      ? base
      : { ...base, deps: { ...base.deps, sagas: wrapSagas(base.deps.sagas) } }

  return withSagaHelpers(world, shared, () => log.entries())
}

function counter(): () => number {
  let value = 0
  return () => {
    value += 1
    return value
  }
}

function eventIdOf(label: string): string {
  const hex = Buffer.from(label).toString('hex').padEnd(12, '0').slice(0, 12)
  return `e0e0e0e0-0000-4000-8000-${hex}`
}

type EventHelpers = Pick<
  SagaWorld,
  | 'paymentSucceeded'
  | 'paymentFailed'
  | 'paymentRefunded'
  | 'supplierConfirmed'
  | 'supplierRejected'
  | 'supplierUncertain'
>

/** Peristiwa payment-service dan supplier-service, langsung ke reaksi saga. */
function eventHelpers(deps: BookingDeps, fresh: () => string): EventHelpers {
  return {
    paymentSucceeded: async (target, options = {}) =>
      await onPaymentSucceeded(deps, {
        eventId: options.eventId ?? fresh(),
        bookingId: target.id,
        paymentId: options.paymentId ?? PAYMENT_ID,
        amount: options.amount ?? target.price.total,
      }),
    paymentFailed: async (target, id) =>
      await onPaymentFailed(deps, {
        eventId: id ?? fresh(),
        bookingId: target.id,
        reason: 'kartu ditolak',
      }),
    paymentRefunded: async (target, options = {}) =>
      await onPaymentRefunded(deps, {
        eventId: options.eventId ?? fresh(),
        bookingId: target.id,
        paymentId: options.paymentId ?? PAYMENT_ID,
        refundId: REFUND_ID,
        amount: options.amount ?? target.price.total,
      }),
    supplierConfirmed: async (target, options = {}) =>
      await onSupplierConfirmed(deps, {
        eventId: options.eventId ?? fresh(),
        bookingId: target.id,
        supplierRef: options.supplierRef ?? SUPPLIER_REF,
      }),
    supplierRejected: async (target, id) =>
      await onSupplierRejected(deps, {
        eventId: id ?? fresh(),
        bookingId: target.id,
        reason: 'sold_out',
      }),
    supplierUncertain: async (target, id) =>
      await onSupplierUncertain(deps, {
        eventId: id ?? fresh(),
        bookingId: target.id,
        reason: 'timeout',
      }),
  }
}

async function heldBooking(deps: BookingDeps, key: string): Promise<Booking> {
  const checked = await startPriceCheck(deps, priceCheckRequest({ key }))
  if (checked.kind !== 'checked') throw new Error(`price check gagal: ${checked.kind}`)
  const result = await placeHold(deps, {
    userId: USER,
    bookingId: checked.booking.id,
    unitsLeft: 5,
  })
  if (result.kind !== 'held') throw new Error(`hold gagal: ${result.kind}`)
  return result.booking
}

function withSagaHelpers(
  world: Harness,
  shared: Shared,
  logs: () => readonly LogEntry[],
): SagaWorld {
  const { deps } = world
  // Penghitungnya milik dunia BERSAMA, bukan proses: pesan baru setelah
  // restart() tidak boleh memakai eventId pesan sebelum restart — catatan
  // pesan terkonsumsi akan (dengan benar) menolaknya sebagai duplikat.
  const fresh = (): string => eventIdOf(`auto${String(shared.nextEvent())}`)
  const events = eventHelpers(deps, fresh)

  const booking = async (id: string): Promise<Booking> => {
    const found = await deps.bookings.findById(id)
    if (found === undefined) throw new Error(`pemesanan ${id} tidak ada`)
    return found
  }
  const held = async (key = 'req-2026-10-01-0001'): Promise<Booking> => await heldBooking(deps, key)

  return {
    ...world,
    ...events,
    logs,
    outbox: () => shared.db.committed().outbox,
    sent: (bookingId) =>
      shared.db
        .committed()
        .outbox.filter((row) => row.bookingId === bookingId)
        .map((row) => row.messageType),
    saga: async (id) => await deps.sagas.find(id),
    booking,
    held,
    paid: async (key) => {
      const target = await held(key)
      await events.paymentSucceeded(target)
      return await booking(target.id)
    },
    eventId: eventIdOf,
    restart: () => build(shared),
  }
}
