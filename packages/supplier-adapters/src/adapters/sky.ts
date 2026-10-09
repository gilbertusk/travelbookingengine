import { err, ok, type Result } from '@tbe/shared-kernel'
import { z } from 'zod'
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
import type { GuestDetails, SearchCriteria, SupplierGateway } from '../ports/supplier-gateway.js'
import { decodeJson, type AdapterContext } from './shared.js'

/**
 * SKY — REST JSON, IDR, camelCase, harga dalam satuan terkecil.
 *
 * Supplier paling lurus dari kelimanya, dan karena itu dipakai sebagai
 * pembanding: bila sebuah persoalan muncul di SKY juga, persoalannya ada di
 * sistem kita, bukan pada keanehan format supplier.
 *
 * Setiap operasi adalah fungsi tersendiri; pabriknya hanya merangkai. Pola
 * yang sama dipakai kelima adapter, sehingga membaca satu berarti dapat
 * membaca semuanya.
 */

const SUPPLIER = 'SKY' as const

const skyMoney = z.object({
  amount: z.number().int(),
  currency: z.literal('IDR'),
})

const skyRate = z.object({
  rateId: z.string().min(1),
  rateName: z.string(),
  price: skyMoney,
  nightlyPrice: skyMoney,
  refundable: z.boolean(),
  breakfast: z.boolean(),
  freeCancellationDays: z.number().int().nonnegative().optional(),
  unitsLeft: z.number().int().nonnegative(),
})

const skyRoom = z.object({
  roomId: z.string().min(1),
  roomName: z.string(),
  maxGuests: z.number().int().positive().optional(),
  rates: z.array(skyRate),
})

const skyHotel = z.object({
  hotelId: z.string().min(1),
  hotelName: z.string().min(1),
  address: z.string().optional(),
  city: z.string().optional(),
  stars: z.number().min(0).max(5).optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  amenities: z.array(z.string()).default([]),
  rooms: z.array(skyRoom),
})

const skySearchResponse = z.object({ results: z.array(skyHotel) })

const skyPriceCheckResponse = z.object({
  rateId: z.string().min(1),
  price: skyMoney,
  changed: z.boolean(),
  refundable: z.boolean(),
  freeCancellationDays: z.number().int().nonnegative().optional(),
})

const skyHoldResponse = z.object({
  holdId: z.string().min(1),
  expiresAt: z.iso.datetime(),
  price: skyMoney,
})

const skyBookingResponse = z.object({
  bookingId: z.string().min(1),
  status: z.enum(['CONFIRMED', 'CANCELLED']),
  price: skyMoney,
  checkIn: z.string(),
  checkOut: z.string(),
  guestName: z.string().optional(),
})

/** SKY menaruh kode galat pada `error`. */
function errorCodeOf(body: unknown): string | undefined {
  const code = (body as { error?: unknown } | undefined)?.error
  return typeof code === 'string' ? code : undefined
}

function context(operation: Operation): AdapterContext {
  return { supplier: SUPPLIER, operation }
}

export function createSkyAdapter(http: SupplierHttp): SupplierGateway {
  return {
    supplier: SUPPLIER,
    search: async (criteria) => await search(http, criteria),
    priceCheck: async (ratePlanId, stay) => await priceCheck(http, ratePlanId, stay),
    hold: async (ratePlanId, stay, guests) => await hold(http, ratePlanId, stay, guests),
    book: async (holdId, guest, key) => await book(http, holdId, guest, key),
    cancel: async (reference) => await cancel(http, reference),
    getBooking: async (reference) => await lookup(http, `/bookings/${encode(reference)}`),
    findBookingByIdempotencyKey: async (key) =>
      await lookup(http, `/bookings?idempotencyKey=${encode(key)}`),
  }
}

function encode(value: string): string {
  return encodeURIComponent(value)
}

async function search(
  http: SupplierHttp,
  criteria: SearchCriteria,
): Promise<Result<SupplierSearchResult, SupplierError>> {
  const sent = await http.send({
    operation: 'search',
    method: 'POST',
    path: '/availability',
    contentType: 'application/json',
    body: JSON.stringify({
      city: criteria.city,
      checkIn: criteria.checkIn,
      checkOut: criteria.checkOut,
      guests: criteria.guests,
    }),
  })
  if (!sent.ok) return sent

  const decoded = decodeJson(context('search'), sent.value, skySearchResponse, errorCodeOf)
  if (!decoded.ok) return decoded

  return ok({
    supplier: SUPPLIER,
    checkIn: criteria.checkIn,
    checkOut: criteria.checkOut,
    properties: decoded.value.results.map(toProperty),
  })
}

async function priceCheck(
  http: SupplierHttp,
  supplierRatePlanId: string,
  stay: { readonly checkIn: string; readonly checkOut: string },
): Promise<Result<PriceCheckResult, SupplierError>> {
  const sent = await http.send({
    operation: 'priceCheck',
    method: 'POST',
    path: '/rates/verify',
    contentType: 'application/json',
    body: JSON.stringify({ rateId: supplierRatePlanId, ...stay }),
  })
  if (!sent.ok) return sent

  const decoded = decodeJson(context('priceCheck'), sent.value, skyPriceCheckResponse, errorCodeOf)
  if (!decoded.ok) return decoded

  return ok({
    supplierRatePlanId: decoded.value.rateId,
    total: money(decoded.value.price.amount, 'IDR'),
    changed: decoded.value.changed,
    cancellationPolicy: cancellationPolicy(
      decoded.value.refundable,
      decoded.value.freeCancellationDays,
    ),
  })
}

async function hold(
  http: SupplierHttp,
  supplierRatePlanId: string,
  stay: { readonly checkIn: string; readonly checkOut: string },
  guests: number,
): Promise<Result<HoldResult, SupplierError>> {
  const sent = await http.send({
    operation: 'hold',
    method: 'POST',
    path: '/holds',
    contentType: 'application/json',
    body: JSON.stringify({ rateId: supplierRatePlanId, ...stay, guests }),
  })
  if (!sent.ok) return sent

  const decoded = decodeJson(context('hold'), sent.value, skyHoldResponse, errorCodeOf)
  if (!decoded.ok) return decoded

  return ok({
    supplierHoldId: decoded.value.holdId,
    expiresAt: decoded.value.expiresAt,
    total: money(decoded.value.price.amount, 'IDR'),
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
    path: '/bookings',
    contentType: 'application/json',
    idempotencyKey,
    body: JSON.stringify({ holdId: supplierHoldId, guestName: guest.fullName, idempotencyKey }),
  })
  if (!sent.ok) return sent

  return toBooking(decodeJson(context('book'), sent.value, skyBookingResponse, errorCodeOf))
}

async function cancel(
  http: SupplierHttp,
  bookingReference: string,
): Promise<Result<void, SupplierError>> {
  const sent = await http.send({
    operation: 'cancel',
    method: 'DELETE',
    path: `/bookings/${encode(bookingReference)}`,
  })
  if (!sent.ok) return sent

  const decoded = decodeJson(context('cancel'), sent.value, skyBookingResponse, errorCodeOf)
  return decoded.ok ? ok(undefined) : err(decoded.error)
}

async function lookup(
  http: SupplierHttp,
  path: string,
): Promise<Result<BookingResult, SupplierError>> {
  const sent = await http.send({ operation: 'getBooking', method: 'GET', path })
  if (!sent.ok) return sent

  return toBooking(decodeJson(context('getBooking'), sent.value, skyBookingResponse, errorCodeOf))
}

function toBooking(
  decoded: Result<z.infer<typeof skyBookingResponse>, SupplierError>,
): Result<BookingResult, SupplierError> {
  if (!decoded.ok) return decoded

  return ok({
    supplier: SUPPLIER,
    bookingReference: decoded.value.bookingId,
    status: decoded.value.status,
    total: money(decoded.value.price.amount, 'IDR'),
    checkIn: decoded.value.checkIn,
    checkOut: decoded.value.checkOut,
    ...(decoded.value.guestName === undefined ? {} : { guestName: decoded.value.guestName }),
  })
}

function toProperty(hotel: z.infer<typeof skyHotel>): SupplierProperty {
  return {
    supplier: SUPPLIER,
    supplierPropertyId: hotel.hotelId,
    name: hotel.hotelName,
    ...(hotel.stars === undefined ? {} : { starRating: hotel.stars }),
    ...(hotel.address === undefined ? {} : { address: hotel.address }),
    ...(hotel.city === undefined ? {} : { city: hotel.city }),
    ...(hotel.latitude === undefined || hotel.longitude === undefined
      ? {}
      : { coordinates: { latitude: hotel.latitude, longitude: hotel.longitude } }),
    amenities: hotel.amenities,
    roomTypes: hotel.rooms.map((room) => ({
      supplierRoomTypeId: room.roomId,
      name: room.roomName,
      ...(room.maxGuests === undefined ? {} : { maxGuests: room.maxGuests }),
      ratePlans: room.rates.map((rate) => ({
        supplierRatePlanId: rate.rateId,
        name: rate.rateName,
        total: money(rate.price.amount, 'IDR'),
        nightly: money(rate.nightlyPrice.amount, 'IDR'),
        cancellationPolicy: cancellationPolicy(rate.refundable, rate.freeCancellationDays),
        breakfastIncluded: rate.breakfast,
        availability: { unitsLeft: rate.unitsLeft },
      })),
    })),
  }
}
