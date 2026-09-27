import { moneySchema, toJson, type Money } from '@tbe/money'
import { z } from 'zod'
import {
  SUPPLIER_CODES,
  type Booking,
  type BookingBase,
  type PriceCheck,
  type SupplierCode,
} from '../domain/booking.js'
import type { BookingEvent } from '../domain/events.js'
import { guestDetails } from '../domain/guest-details.js'
import { parseIdempotencyKey } from '../domain/idempotency-key.js'
import { LINE_ITEM_KINDS, priceBreakdown, type PriceBreakdown } from '../domain/price.js'
import { parseLocalDate, stayDates, type LocalDate } from '../domain/stay-dates.js'
import type {
  BookingRow,
  BookingStateColumns,
  BookingWriteColumns,
  EventWriteColumns,
  JsonInput,
  JsonObject,
} from './booking-db.js'
import { BookingRowReader, CorruptBookingRowError } from './booking-row-reader.js'

/**
 * Pemetaan antara pemesanan domain dan baris basis data.
 *
 * Arah baca TIDAK mempercayai basis data. Setiap baris disusun ulang lewat
 * konstruktor domain yang sama dengan jalur tulis — `stayDates`, `guestDetails`,
 * `priceBreakdown`, `parseIdempotencyKey` — sehingga baris yang dirusak skrip
 * perbaikan data atau migrasi yang salah menjadi galat yang menyebut kolomnya,
 * bukan pemesanan yang diam-diam berbeda dari yang ditulis.
 */

/**
 * Kolom DATE ditulis sebagai tengah malam UTC tanggal itu.
 *
 * Bukan `new Date(tahun, bulan, hari)`: konstruktor itu memakai zona MESIN, dan
 * di Jakarta tengah malam lokal 10 November adalah 9 November pukul 17:00 UTC —
 * Postgres menyimpan 9 November. Uji di booking-rows.test.ts berjalan di zona
 * America/Los_Angeles (vitest.config.ts) supaya kesalahan ini terlihat.
 */
export function toDateColumn(date: LocalDate): Date {
  return new Date(`${date}T00:00:00.000Z`)
}

/**
 * Kolom DATE dibaca kembali dengan getter UTC, lewat `toISOString`.
 *
 * Bukan `getFullYear()`/`getDate()`: keduanya memakai zona mesin, dan di Los
 * Angeles tengah malam UTC 10 November masih 9 November.
 *
 * `undefined` untuk tahun di luar empat digit: DATE Postgres menerima tahun
 * 10000 ke atas, tetapi `toISOString` menuliskannya `+010000-...`, yang bukan
 * tanggal menginap mana pun.
 */
export function fromDateColumn(value: Date): LocalDate | undefined {
  return parseLocalDate(value.toISOString().slice(0, 10))
}

const lineItemsSchema = z.array(
  z.object({ kind: z.enum(LINE_ITEM_KINDS), description: z.string(), amount: moneySchema }),
)

const priceLinesSchema = z.object({ agreed: lineItemsSchema, quoted: lineItemsSchema.nullable() })

function lineItemsJson(price: PriceBreakdown): JsonInput {
  return price.lineItems.map((item) => ({
    kind: item.kind,
    description: item.description,
    amount: toJson(item.amount),
  }))
}

function quoteOf(booking: Booking): PriceBreakdown | undefined {
  return booking.priceCheck?.kind === 'changed' ? booking.priceCheck.quoted : undefined
}

export function toStateColumns(booking: Booking): BookingStateColumns & { priceLines: JsonObject } {
  const quote = quoteOf(booking)

  return {
    status: booking.status,
    amountMinor: booking.price.total.amountMinor,
    currency: booking.price.total.currency,
    priceLines: {
      agreed: lineItemsJson(booking.price),
      quoted: quote === undefined ? null : lineItemsJson(quote),
    },
    priceCheck: booking.priceCheck?.kind ?? null,
    quotedAmountMinor: quote?.total.amountMinor ?? null,
    quotedCurrency: quote?.total.currency ?? null,
    holdRef: booking.holdRef ?? null,
    heldUntil: booking.heldUntil ?? null,
    paymentId: booking.paymentId ?? null,
    supplierRef: booking.supplierRef ?? null,
    refundId: booking.refundId ?? null,
    failureReason: booking.failure?.reason ?? null,
    cancellation: booking.cancellation ?? null,
    reviewReason: booking.review?.reason ?? null,
    reviewFrom: booking.review?.from ?? null,
    version: booking.version,
    updatedAt: booking.updatedAt,
  }
}

export function toRow(booking: Booking): BookingWriteColumns {
  return {
    id: booking.id,
    userId: booking.userId,
    supplierId: booking.supplier,
    propertyId: booking.propertyId,
    city: booking.city,
    ratePlanRef: booking.ratePlanRef,
    checkIn: toDateColumn(booking.stay.checkIn),
    checkOut: toDateColumn(booking.stay.checkOut),
    guests: booking.guests.count,
    leadGuestName: booking.guests.leadGuest.fullName,
    leadGuestEmail: booking.guests.leadGuest.email,
    idempotencyKey: booking.idempotencyKey,
    createdAt: booking.createdAt,
    ...toStateColumns(booking),
  }
}

/**
 * Baris peristiwa. `payload` adalah seluruh isi peristiwa selain bidang yang
 * sudah menjadi kolom sendiri, dengan tanggal sebagai ISO dan uang sebagai
 * `{ amountMinor, currency }` — bentuk yang sama dengan kontrak pesan.
 */
export function toEventRow(event: BookingEvent): EventWriteColumns {
  const { type, bookingId, version, occurredAt, ...rest } = event

  return {
    bookingId,
    sequence: version,
    eventType: type,
    payload: toJsonObject(rest),
    occurredAt,
  }
}

/**
 * Isi peristiwa sebagai objek JSON.
 *
 * Hanya bentuk yang memang ada di peristiwa domain yang diterima: teks,
 * bilangan, boolean, `Date`, dan objek bersarang (`Money`, `StayDates`).
 * Selain itu DILEMPAR, dengan nama bidangnya.
 *
 * Versi pertama menerima segala `unknown`: larik dipetakan, dan sisanya —
 * `undefined`, `bigint`, fungsi — menjadi `null`. Cakupan uji memperlihatkan
 * kedua cabang itu tidak pernah tersentuh, karena peristiwa domain tidak punya
 * larik maupun bidang kosong. Pertanyaan "apa yang terjadi bila tersentuh"
 * jawabannya buruk: jejak audit (NFR-10) kehilangan data tanpa suara. Bidang
 * baru yang tidak dapat disimpan harus menggagalkan penulisan — dan karena
 * penulisan itu di dalam transaksi, keadaan pemesanannya ikut batal.
 */
export function toJsonObject(value: object): JsonObject {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, toJsonInput(key, item)]),
  )
}

function toJsonInput(key: string, value: unknown): JsonInput {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return toJsonObject(value)
  }

  throw new TypeError(`Bidang peristiwa ${key} tidak dapat disimpan sebagai JSON`)
}

export function fromRow(row: BookingRow): Booking {
  const read = new BookingRowReader(row)
  const base = baseFromRow(row, read)

  switch (row.status) {
    case 'DRAFT':
      return { ...base, status: 'DRAFT' }
    case 'PRICE_CHECKED':
      return { ...base, status: 'PRICE_CHECKED', priceCheck: priceCheckFromRow(row, read) }
    case 'HELD':
    case 'EXPIRED':
      return {
        ...base,
        status: row.status,
        holdRef: read.required('holdRef'),
        heldUntil: read.required('heldUntil'),
      }
    case 'CANCELLED':
      return { ...base, status: 'CANCELLED', cancellation: read.required('cancellation') }
    case 'PAID':
    case 'CONFIRMED':
    case 'FAILED':
    case 'REFUNDED':
    case 'NEEDS_REVIEW':
      return paidFromRow(row.status, base, read)
  }
}

/** Keadaan sesudah uang diterima: semuanya wajib menyebut pembayarannya. */
function paidFromRow(
  status: 'PAID' | 'CONFIRMED' | 'FAILED' | 'REFUNDED' | 'NEEDS_REVIEW',
  base: BookingBase,
  read: BookingRowReader,
): Booking {
  const paid = { ...base, paymentId: read.required('paymentId') }

  switch (status) {
    case 'PAID':
      return { ...paid, status }
    case 'CONFIRMED':
      return { ...paid, status, supplierRef: read.required('supplierRef') }
    case 'FAILED':
      return { ...paid, status, failure: { reason: read.required('failureReason') } }
    case 'REFUNDED':
      return {
        ...paid,
        status,
        failure: { reason: read.required('failureReason') },
        refundId: read.required('refundId'),
      }
    case 'NEEDS_REVIEW':
      return {
        ...paid,
        status,
        review: { from: read.reviewFrom(), reason: read.required('reviewReason') },
      }
  }
}

function baseFromRow(row: BookingRow, read: BookingRowReader): BookingBase {
  const stay = stayDates({
    checkIn: read.check(fromDateColumn(row.checkIn), 'checkIn'),
    checkOut: read.check(fromDateColumn(row.checkOut), 'checkOut'),
  })
  const guests = guestDetails({
    fullName: row.leadGuestName,
    email: row.leadGuestEmail,
    count: row.guests,
  })
  const idempotencyKey = parseIdempotencyKey(row.idempotencyKey)

  return {
    id: row.id,
    userId: row.userId,
    supplier: read.check(supplierOf(row.supplierId), 'supplierId'),
    propertyId: row.propertyId,
    city: row.city,
    ratePlanRef: row.ratePlanRef,
    stay: read.check(stay.ok ? stay.value : undefined, 'checkIn/checkOut'),
    guests: read.check(guests.ok ? guests.value : undefined, 'guests'),
    price: agreedPrice(row, read),
    idempotencyKey: read.check(idempotencyKey, 'idempotencyKey'),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function supplierOf(value: string): SupplierCode | undefined {
  return SUPPLIER_CODES.find((code) => code === value)
}

function priceLinesOf(row: BookingRow, read: BookingRowReader) {
  const parsed = priceLinesSchema.safeParse(row.priceLines)

  return read.check(parsed.success ? parsed.data : undefined, 'priceLines')
}

function breakdownOf(
  items: z.infer<typeof lineItemsSchema>,
  expected: Money,
  read: BookingRowReader,
  column: string,
): PriceBreakdown {
  const built = priceBreakdown(items)
  const price = read.check(built.ok ? built.value : undefined, column)

  // Total yang dijumlahkan ulang harus sama dengan kolom skalarnya. Keduanya
  // ditulis bersama; perbedaan berarti salah satunya diubah tanpa yang lain.
  const matches =
    price.total.currency === expected.currency && price.total.amountMinor === expected.amountMinor
  if (!matches)
    throw new CorruptBookingRowError(read.id, column, 'total tidak sama dengan kolomnya')

  return price
}

function agreedPrice(row: BookingRow, read: BookingRowReader): PriceBreakdown {
  const expected = read.money(row.amountMinor, row.currency, 'amountMinor/currency')

  return breakdownOf(priceLinesOf(row, read).agreed, expected, read, 'priceLines.agreed')
}

function priceCheckFromRow(row: BookingRow, read: BookingRowReader): PriceCheck {
  const kind = read.required('priceCheck')
  if (kind !== 'changed') return { kind }

  const expected = read.money(
    read.required('quotedAmountMinor'),
    read.required('quotedCurrency'),
    'quotedAmountMinor/quotedCurrency',
  )
  const quoted = read.check(priceLinesOf(row, read).quoted ?? undefined, 'priceLines.quoted')

  return { kind, quoted: breakdownOf(quoted, expected, read, 'priceLines.quoted') }
}
