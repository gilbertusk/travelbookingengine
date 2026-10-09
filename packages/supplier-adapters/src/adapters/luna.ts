import { err, ok, type Result } from '@tbe/shared-kernel'
import { z } from 'zod'
import { calendarDateFromEpochSeconds, epochSecondsFromCalendarDate } from '../canonical/dates.js'
import { money } from '../canonical/money.js'
import { cancellationPolicy } from '../canonical/model.js'
import type {
  BookingResult,
  HoldResult,
  PriceCheckResult,
  SupplierProperty,
  SupplierSearchResult,
} from '../canonical/model.js'
import type { SupplierError } from '../errors/supplier-error.js'
import type { Operation, SupplierHttp } from '../http/client.js'
import { invalidResponse } from '../http/failure.js'
import type { GuestDetails, SearchCriteria, SupplierGateway } from '../ports/supplier-gateway.js'
import { decodeJson, type AdapterContext } from './shared.js'

/**
 * LUNA — REST JSON, IDR, tanggal epoch detik, nama field terpangkas.
 *
 * Dua hal yang khas LUNA:
 *
 * 1. Boolean datang sebagai 0 dan 1. `Boolean(0)` kebetulan benar, tetapi
 *    skema yang menerima `z.boolean()` akan menolak seluruh respons — jadi
 *    angkanya divalidasi sebagai angka lalu diubah, bukan dipaksa.
 * 2. Tanggal datang sebagai epoch detik. Mengubahnya kembali dengan zona
 *    waktu mesin menggeser seluruh menginap satu hari di sebagian zona.
 *
 * LUNA juga selalu membalas dengan amplop `{ ok, data }` — bahkan saat gagal,
 * ketika `ok` bernilai false dan badan responsnya berisi `err`.
 */

const SUPPLIER = 'LUNA' as const

/** 0 dan 1, bukan false dan true. */
const lunaBoolean = z.union([z.literal(0), z.literal(1)]).transform((value) => value === 1)

const lunaRatePlan = z.object({
  pid: z.string().min(1),
  pname: z.string(),
  amt: z.number().int(),
  namt: z.number().int(),
  cur: z.literal('IDR'),
  ref: lunaBoolean,
  bf: lunaBoolean,
  left: z.number().int().nonnegative(),
})

const lunaRoom = z.object({
  rid: z.string().min(1),
  rname: z.string(),
  mx: z.number().int().positive().optional(),
  rp: z.array(lunaRatePlan),
})

const lunaItem = z.object({
  hid: z.string().min(1),
  hname: z.string().min(1),
  st: z.number().min(0).max(5).optional(),
  rt: z.array(lunaRoom),
})

const lunaSearchResponse = z.object({
  ok: z.literal(true),
  data: z.object({ items: z.array(lunaItem) }),
})

const lunaRateResponse = z.object({
  ok: z.literal(true),
  data: z.object({
    pid: z.string().min(1),
    amt: z.number().int(),
    chg: z.boolean(),
    ref: lunaBoolean,
  }),
})

const lunaHoldResponse = z.object({
  ok: z.literal(true),
  data: z.object({ h: z.string().min(1), exp: z.number().int(), amt: z.number().int() }),
})

const lunaBookingResponse = z.object({
  ok: z.literal(true),
  data: z.object({
    b: z.string().min(1),
    st: lunaBoolean,
    amt: z.number().int(),
    in: z.number().int(),
    out: z.number().int(),
  }),
})

/** LUNA menaruh kode galat pada `err`. */
function errorCodeOf(body: unknown): string | undefined {
  const code = (body as { err?: unknown } | undefined)?.err
  return typeof code === 'string' ? code : undefined
}

function context(operation: Operation): AdapterContext {
  return { supplier: SUPPLIER, operation }
}

function stayEpoch(
  stay: { readonly checkIn: string; readonly checkOut: string },
  operation: Operation,
): Result<{ in: number; out: number }, SupplierError> {
  const from = epochSecondsFromCalendarDate(stay.checkIn)
  const to = epochSecondsFromCalendarDate(stay.checkOut)

  if (from === undefined || to === undefined) {
    return err(invalidResponse(SUPPLIER, operation, 'tanggal menginap tidak sah'))
  }

  return ok({ in: from, out: to })
}

export function createLunaAdapter(http: SupplierHttp): SupplierGateway {
  return {
    supplier: SUPPLIER,
    search: async (criteria) => await search(http, criteria),
    priceCheck: async (pid, stay) => await priceCheck(http, pid, stay),
    hold: async (pid, stay, guests) => await hold(http, pid, stay, guests),
    book: async (holdRef, guest, key) => await book(http, holdRef, guest, key),
    cancel: async (reference) => await cancel(http, reference),
    getBooking: async (reference) => await lookup(http, `/bk?b=${encode(reference)}`),
    findBookingByIdempotencyKey: async (key) => await lookup(http, `/bk?ik=${encode(key)}`),
  }
}

function encode(value: string): string {
  return encodeURIComponent(value)
}

async function search(
  http: SupplierHttp,
  criteria: SearchCriteria,
): Promise<Result<SupplierSearchResult, SupplierError>> {
  const stay = stayEpoch(criteria, 'search')
  if (!stay.ok) return stay

  const sent = await http.send({
    operation: 'search',
    method: 'POST',
    path: '/availability',
    contentType: 'application/json',
    body: JSON.stringify({
      q: { loc: criteria.city, in: stay.value.in, out: stay.value.out, pax: criteria.guests },
    }),
  })
  if (!sent.ok) return sent

  const decoded = decodeJson(context('search'), sent.value, lunaSearchResponse, errorCodeOf)
  if (!decoded.ok) return decoded

  return ok({
    supplier: SUPPLIER,
    checkIn: criteria.checkIn,
    checkOut: criteria.checkOut,
    properties: decoded.value.data.items.map(toProperty),
  })
}

async function priceCheck(
  http: SupplierHttp,
  supplierRatePlanId: string,
  stay: { readonly checkIn: string; readonly checkOut: string },
): Promise<Result<PriceCheckResult, SupplierError>> {
  const dates = stayEpoch(stay, 'priceCheck')
  if (!dates.ok) return dates

  const sent = await http.send({
    operation: 'priceCheck',
    method: 'POST',
    path: '/rate',
    contentType: 'application/json',
    body: JSON.stringify({ pid: supplierRatePlanId, ...dates.value }),
  })
  if (!sent.ok) return sent

  const decoded = decodeJson(context('priceCheck'), sent.value, lunaRateResponse, errorCodeOf)
  if (!decoded.ok) return decoded

  return ok({
    supplierRatePlanId: decoded.value.data.pid,
    total: money(decoded.value.data.amt, 'IDR'),
    changed: decoded.value.data.chg,
    cancellationPolicy: cancellationPolicy(decoded.value.data.ref),
  })
}

async function hold(
  http: SupplierHttp,
  supplierRatePlanId: string,
  stay: { readonly checkIn: string; readonly checkOut: string },
  guests: number,
): Promise<Result<HoldResult, SupplierError>> {
  const dates = stayEpoch(stay, 'hold')
  if (!dates.ok) return dates

  const sent = await http.send({
    operation: 'hold',
    method: 'POST',
    path: '/hold',
    contentType: 'application/json',
    body: JSON.stringify({ pid: supplierRatePlanId, ...dates.value, pax: guests }),
  })
  if (!sent.ok) return sent

  const decoded = decodeJson(context('hold'), sent.value, lunaHoldResponse, errorCodeOf)
  if (!decoded.ok) return decoded

  // `exp` adalah titik waktu sungguhan, bukan tanggal kalender — hold
  // berakhir pada detik tertentu, bukan pada akhir hari.
  const expiresAt = new Date(decoded.value.data.exp * 1_000).toISOString()

  return ok({
    supplierHoldId: decoded.value.data.h,
    expiresAt,
    total: money(decoded.value.data.amt, 'IDR'),
  })
}

async function book(
  http: SupplierHttp,
  supplierHoldId: string,
  guest: GuestDetails,
  idempotencyKey: string,
): Promise<Result<BookingResult, SupplierError>> {
  const sent = await http.send({
    operation: 'book',
    method: 'POST',
    path: '/book',
    contentType: 'application/json',
    idempotencyKey,
    body: JSON.stringify({ h: supplierHoldId, gn: guest.fullName, ik: idempotencyKey }),
  })
  if (!sent.ok) return sent

  return toBooking(
    decodeJson(context('book'), sent.value, lunaBookingResponse, errorCodeOf),
    'book',
  )
}

async function cancel(
  http: SupplierHttp,
  bookingReference: string,
): Promise<Result<void, SupplierError>> {
  const sent = await http.send({
    operation: 'cancel',
    method: 'POST',
    path: '/void',
    contentType: 'application/json',
    body: JSON.stringify({ b: bookingReference }),
  })
  if (!sent.ok) return sent

  const decoded = decodeJson(context('cancel'), sent.value, lunaBookingResponse, errorCodeOf)
  return decoded.ok ? ok(undefined) : err(decoded.error)
}

async function lookup(
  http: SupplierHttp,
  path: string,
): Promise<Result<BookingResult, SupplierError>> {
  const sent = await http.send({ operation: 'getBooking', method: 'GET', path })
  if (!sent.ok) return sent

  return toBooking(
    decodeJson(context('getBooking'), sent.value, lunaBookingResponse, errorCodeOf),
    'getBooking',
  )
}

function toBooking(
  decoded: Result<z.infer<typeof lunaBookingResponse>, SupplierError>,
  operation: Operation,
): Result<BookingResult, SupplierError> {
  if (!decoded.ok) return decoded

  const checkIn = calendarDateFromEpochSeconds(decoded.value.data.in)
  const checkOut = calendarDateFromEpochSeconds(decoded.value.data.out)

  if (checkIn === undefined || checkOut === undefined) {
    return err(invalidResponse(SUPPLIER, operation, 'tanggal menginap bukan epoch yang sah'))
  }

  return ok({
    supplier: SUPPLIER,
    bookingReference: decoded.value.data.b,
    status: decoded.value.data.st ? 'CONFIRMED' : 'CANCELLED',
    total: money(decoded.value.data.amt, 'IDR'),
    checkIn,
    checkOut,
  })
}

function toProperty(item: z.infer<typeof lunaItem>): SupplierProperty {
  return {
    supplier: SUPPLIER,
    supplierPropertyId: item.hid,
    name: item.hname,
    ...(item.st === undefined ? {} : { starRating: item.st }),
    amenities: [],
    roomTypes: item.rt.map((room) => ({
      supplierRoomTypeId: room.rid,
      name: room.rname,
      ...(room.mx === undefined ? {} : { maxGuests: room.mx }),
      ratePlans: room.rp.map((rate) => ({
        supplierRatePlanId: rate.pid,
        name: rate.pname,
        total: money(rate.amt, 'IDR'),
        nightly: money(rate.namt, 'IDR'),
        cancellationPolicy: cancellationPolicy(rate.ref),
        breakfastIncluded: rate.bf,
        availability: { unitsLeft: rate.left },
      })),
    })),
  }
}
