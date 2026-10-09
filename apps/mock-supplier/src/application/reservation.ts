import { err, ok, type Result } from '@tbe/shared-kernel'
import {
  cancelBooking,
  isHoldExpired,
  type Booking,
  type Hold,
  type OperationFailure,
} from '../domain/booking.js'
import { driftedPriceMinorIdr, stayTotalMinorIdr } from '../domain/pricing.js'
import { enumerateNights, validateStay } from '../domain/stay.js'
import { coversProperty, supplierPriceMultiplier, type SupplierCode } from '../domain/supplier.js'
import { shouldDriftPrice, type SupplierChaos } from './chaos.js'
import type { OperationDeps } from './ports.js'
import { applyMultiplier, unitsLeftFor } from './search.js'

/**
 * Hold, book, cancel, dan pemulihan status.
 *
 * Tiga sifat yang wajib benar di sini, karena Step 11, 19, dan 22 bersandar
 * padanya: hold kedaluwarsa mengembalikan unitnya, book idempoten terhadap
 * idempotency key, dan status pemesanan selalu dapat ditanyakan ulang setelah
 * jawaban hilang di jaringan.
 */

export interface StayRequest {
  readonly supplier: SupplierCode
  readonly ratePlanId: string
  readonly checkIn: string
  readonly checkOut: string
}

export interface PriceCheckResult {
  readonly totalMinorIdr: number
  readonly baseTotalMinorIdr: number
  readonly changed: boolean
  /**
   * Kebijakan pembatalan rate plan, diulang di price check (Step 25) dalam
   * dialek masing-masing supplier — sama dengan yang tampil di pencarian.
   */
  readonly policy: RatePlanPolicy
}

export interface RatePlanPolicy {
  readonly refundable: boolean
  readonly freeCancellationDays: number
}

/**
 * Membebaskan unit milik hold yang sudah lewat waktunya.
 *
 * Dipanggil di awal setiap operasi, bukan hanya lewat penjadwal. Penyapuan
 * yang hanya berkala membuat ketersediaan terlihat salah selama jeda antar
 * sapuan, dan pengujian oversell akan mengeluhkan sesuatu yang sebenarnya
 * hanya persoalan waktu.
 */
export function sweepExpiredHolds(deps: OperationDeps): number {
  const expired = deps.store.expiredHolds(deps.clock.now())

  for (const hold of expired) {
    deps.store.release(hold.ratePlanId, enumerateNights(hold.checkIn, hold.checkOut), 1)
    deps.store.removeHold(hold.ref)
  }

  return expired.length
}

function priceKey(request: StayRequest): string {
  return `${request.supplier}:${request.ratePlanId}:${request.checkIn}:${request.checkOut}`
}

function basePriceFor(deps: OperationDeps, request: StayRequest): number | undefined {
  const ratePlan = deps.catalog.ratePlan(request.ratePlanId)
  if (ratePlan === undefined) return undefined

  const nights = enumerateNights(request.checkIn, request.checkOut)
  return applyMultiplier(
    stayTotalMinorIdr(ratePlan, nights),
    supplierPriceMultiplier(request.supplier, request.ratePlanId),
  )
}

export function currentPrice(deps: OperationDeps, request: StayRequest): number | undefined {
  return deps.store.driftedPrice(priceKey(request)) ?? basePriceFor(deps, request)
}

export function priceCheck(
  deps: OperationDeps,
  request: StayRequest,
  chaos: SupplierChaos,
): Result<PriceCheckResult, OperationFailure> {
  sweepExpiredHolds(deps)

  const problem = validateStay(request.checkIn, request.checkOut)
  if (problem !== undefined) return err({ kind: 'invalid_request', reason: problem })

  const base = basePriceFor(deps, request)
  const ratePlan = deps.catalog.ratePlan(request.ratePlanId)
  if (base === undefined || ratePlan === undefined) {
    return err({ kind: 'not_found', what: 'rate_plan' })
  }

  const policy = {
    refundable: ratePlan.refundable,
    freeCancellationDays: ratePlan.freeCancellationDays,
  }
  const key = priceKey(request)
  const existing = deps.store.driftedPrice(key)

  if (existing !== undefined) {
    return ok({
      totalMinorIdr: existing,
      baseTotalMinorIdr: base,
      changed: existing !== base,
      policy,
    })
  }

  if (!shouldDriftPrice(request.supplier, chaos, deps.random)) {
    return ok({ totalMinorIdr: base, baseTotalMinorIdr: base, changed: false, policy })
  }

  const drifted = driftedPriceMinorIdr(base, key)
  deps.store.setDriftedPrice(key, drifted)
  return ok({ totalMinorIdr: drifted, baseTotalMinorIdr: base, changed: drifted !== base, policy })
}

export interface HoldRequest extends StayRequest {
  readonly guests: number
  readonly ttlMs?: number | undefined
}

export function hold(deps: OperationDeps, request: HoldRequest): Result<Hold, OperationFailure> {
  sweepExpiredHolds(deps)

  const problem = validateStay(request.checkIn, request.checkOut)
  if (problem !== undefined) return err({ kind: 'invalid_request', reason: problem })

  const ratePlan = deps.catalog.ratePlan(request.ratePlanId)
  if (ratePlan === undefined || !coversProperty(request.supplier, ratePlan.propertyId)) {
    return err({ kind: 'not_found', what: 'rate_plan' })
  }

  const nights = enumerateNights(request.checkIn, request.checkOut)
  if (unitsLeftFor(deps, request.ratePlanId, nights) <= 0) return err({ kind: 'sold_out' })

  deps.store.consume(request.ratePlanId, nights, 1)

  const now = deps.clock.now()
  const record: Hold = {
    ref: deps.newRef('hld'),
    supplier: request.supplier,
    ratePlanId: request.ratePlanId,
    checkIn: request.checkIn,
    checkOut: request.checkOut,
    guests: request.guests,
    priceMinorIdr: currentPrice(deps, request) ?? 0,
    createdAtMs: now,
    expiresAtMs: now + (request.ttlMs ?? deps.holdTtlMs),
  }

  deps.store.putHold(record)
  return ok(record)
}

export interface BookRequest {
  readonly supplier: SupplierCode
  readonly holdRef: string
  readonly guestName: string
  readonly idempotencyKey: string
}

export interface BookResult {
  readonly booking: Booking
  /** true bila permintaan ini mengulang permintaan yang sudah pernah berhasil. */
  readonly replayed: boolean
}

export function book(
  deps: OperationDeps,
  request: BookRequest,
): Result<BookResult, OperationFailure> {
  // Idempotency diperiksa SEBELUM penyapuan dan sebelum hold dilihat.
  // Percobaan ulang setelah timeout datang ketika hold-nya sudah dipakai dan
  // mungkin sudah kedaluwarsa; yang menentukan jawabannya adalah kuncinya,
  // bukan keadaan hold.
  const existing = deps.store.bookingByIdempotencyKey(request.supplier, request.idempotencyKey)
  if (existing !== undefined) return ok({ booking: existing, replayed: true })

  sweepExpiredHolds(deps)

  const heldRecord = deps.store.hold(request.holdRef)
  if (heldRecord?.supplier !== request.supplier) {
    return err({ kind: 'not_found', what: 'hold' })
  }
  if (isHoldExpired(heldRecord, deps.clock.now())) return err({ kind: 'hold_expired' })

  const booking: Booking = {
    ref: deps.newRef('bkg'),
    supplier: request.supplier,
    holdRef: heldRecord.ref,
    ratePlanId: heldRecord.ratePlanId,
    checkIn: heldRecord.checkIn,
    checkOut: heldRecord.checkOut,
    guests: heldRecord.guests,
    guestName: request.guestName,
    amountMinorIdr: heldRecord.priceMinorIdr,
    status: 'CONFIRMED',
    idempotencyKey: request.idempotencyKey,
    createdAtMs: deps.clock.now(),
  }

  // Hold dilepas dari daftar tetapi unitnya TIDAK dikembalikan — unit itu
  // sekarang terjual. Mengembalikannya di sini adalah cara paling mudah
  // menciptakan oversell tanpa disadari.
  deps.store.removeHold(heldRecord.ref)
  deps.store.putBooking(booking)

  return ok({ booking, replayed: false })
}

export function cancel(
  deps: OperationDeps,
  request: { readonly supplier: SupplierCode; readonly bookingRef: string },
): Result<Booking, OperationFailure> {
  const existing = deps.store.booking(request.bookingRef)
  if (existing?.supplier !== request.supplier) {
    return err({ kind: 'not_found', what: 'booking' })
  }
  if (existing.status === 'CANCELLED') return err({ kind: 'already_cancelled' })

  const cancelled = cancelBooking(existing, deps.clock.now())
  deps.store.release(existing.ratePlanId, enumerateNights(existing.checkIn, existing.checkOut), 1)
  deps.store.putBooking(cancelled)

  return ok(cancelled)
}

/**
 * Menanyakan ulang status pemesanan.
 *
 * Boleh dicari lewat booking reference atau lewat idempotency key. Yang kedua
 * adalah jalan keluar dari ketidakpastian pada US-05: ketika permintaan book
 * melewati batas waktu tanpa jawaban, sistem tidak tahu apakah pemesanan
 * terbentuk, dan satu-satunya cara aman mencari tahu adalah bertanya dengan
 * kunci yang dipakainya.
 */
export function findBooking(
  deps: OperationDeps,
  request: {
    readonly supplier: SupplierCode
    readonly bookingRef?: string | undefined
    readonly idempotencyKey?: string | undefined
  },
): Result<Booking, OperationFailure> {
  const found =
    request.bookingRef !== undefined
      ? deps.store.booking(request.bookingRef)
      : request.idempotencyKey !== undefined
        ? deps.store.bookingByIdempotencyKey(request.supplier, request.idempotencyKey)
        : undefined

  if (found?.supplier !== request.supplier) {
    return err({ kind: 'not_found', what: 'booking' })
  }

  return ok(found)
}

export interface ReservationSnapshot {
  readonly holds: readonly Hold[]
  readonly bookings: readonly Booking[]
}

/**
 * Seluruh hold AKTIF dan seluruh pemesanan — kebenaran dasar untuk invarian
 * uji integrasi Step 20 ("tidak ada hold yatim di supplier", "tidak ada
 * pemesanan ganda").
 *
 * Hold yang sudah lewat DISAPU lebih dulu, sama seperti setiap operasi lain.
 * Tanpa itu, hold yang sebenarnya sudah habis masih terlihat sampai operasi
 * berikutnya menyentuh supplier, dan invariannya gagal karena persoalan waktu
 * penyapuan — bukan karena ada hold yang benar-benar tertinggal.
 *
 * Seperti /admin/catalog, ini sesuatu yang tidak pernah diterbitkan supplier
 * sungguhan, dan tidak satu pun kode di jalur produksi boleh memanggilnya.
 */
export function reservationSnapshot(deps: OperationDeps): ReservationSnapshot {
  sweepExpiredHolds(deps)
  return { holds: deps.store.holds(), bookings: deps.store.bookings() }
}
