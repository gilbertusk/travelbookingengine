import { err, ok, type Result } from '@tbe/shared-kernel'
import { z } from 'zod'
import { money, parseDecimalAmount, type Money } from '../canonical/money.js'
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
 * ZEPH — REST JSON, USD, harga sebagai string, amplop { status, payload }.
 *
 * Angka datang sebagai string di mana-mana: harga, peringkat bintang, sisa
 * unit. `Number("262.37")` bekerja; `Number("1,250.00")` menghasilkan NaN,
 * dan NaN yang lolos menjadi harga akan tampil sebagai "Rp NaN" di layar
 * pengguna, atau lebih buruk, menjadi 0 setelah pembulatan.
 *
 * ZEPH juga supplier paling tidak stabil — sekitar 15% permintaan gagal tanpa
 * suntikan apa pun. Itu bukan urusan adapter: percobaan ulang milik Step 11.
 * Yang harus benar di sini hanyalah kegagalannya terlaporkan dengan jenis
 * yang tepat.
 */

const SUPPLIER = 'ZEPH' as const

/** Bilangan bulat yang datang sebagai string. */
const numericString = z
  .string()
  .regex(/^\d+$/, 'bukan bilangan bulat')
  .transform((value) => Number(value))

const zephOffer = z.object({
  ref: z.string().min(1),
  price: z.string().min(1),
  nightly: z.string().min(1),
  currency: z.literal('USD'),
  cancellable: z.boolean(),
  breakfast: z.boolean(),
  remaining: numericString,
})

const zephRoom = z.object({
  ref: z.string().min(1),
  name: z.string(),
  offers: z.array(zephOffer),
})

const zephHotel = z.object({
  ref: z.string().min(1),
  name: z.string().min(1),
  rating: numericString.optional(),
  rooms: z.array(zephRoom),
})

function envelope<T extends z.ZodType>(payload: T) {
  return z.object({ status: z.literal('ok'), payload })
}

const zephSearchResponse = envelope(z.object({ hotels: z.array(zephHotel) }))

const zephPriceResponse = envelope(
  z.object({
    offer_ref: z.string().min(1),
    price: z.string().min(1),
    currency: z.literal('USD'),
    changed: z.boolean(),
  }),
)

const zephHoldResponse = envelope(
  z.object({
    hold_ref: z.string().min(1),
    expires_at: z.iso.datetime(),
    price: z.string().min(1),
    currency: z.literal('USD'),
  }),
)

const zephBookingResponse = envelope(
  z.object({
    ref: z.string().min(1),
    state: z.enum(['confirmed', 'cancelled']),
    price: z.string().min(1),
    currency: z.literal('USD'),
    dates: z.object({ from: z.string(), to: z.string() }),
  }),
)

/** ZEPH menaruh kode galat pada `error.code`. */
function errorCodeOf(body: unknown): string | undefined {
  const error = (body as { error?: { code?: unknown } } | undefined)?.error
  return typeof error?.code === 'string' ? error.code : undefined
}

function context(operation: Operation): AdapterContext {
  return { supplier: SUPPLIER, operation }
}

function toMoney(value: string, operation: Operation): Result<Money, SupplierError> {
  const minor = parseDecimalAmount(value, 'USD')

  return minor === undefined
    ? err(invalidResponse(SUPPLIER, operation, `harga "${value}" bukan desimal yang sah`))
    : ok(money(minor, 'USD'))
}

export function createZephAdapter(http: SupplierHttp): SupplierGateway {
  return {
    supplier: SUPPLIER,
    search: async (criteria) => await search(http, criteria),
    priceCheck: async (offerRef, stay) => await priceCheck(http, offerRef, stay),
    hold: async (offerRef, stay, guests) => await hold(http, offerRef, stay, guests),
    book: async (holdRef, guest, key) => await book(http, holdRef, guest, key),
    cancel: async (reference) => await cancel(http, reference),
    getBooking: async (reference) => await lookup(http, `/bookings/${encode(reference)}`),
    findBookingByIdempotencyKey: async (key) =>
      await lookup(http, `/bookings?request_id=${encode(key)}`),
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
      location: criteria.city,
      dates: { from: criteria.checkIn, to: criteria.checkOut },
      pax: criteria.guests,
    }),
  })
  if (!sent.ok) return sent

  const decoded = decodeJson(context('search'), sent.value, zephSearchResponse, errorCodeOf)
  if (!decoded.ok) return decoded

  const properties: SupplierProperty[] = []
  for (const hotel of decoded.value.payload.hotels) {
    const mapped = toProperty(hotel)
    if (!mapped.ok) return mapped
    properties.push(mapped.value)
  }

  return ok({
    supplier: SUPPLIER,
    checkIn: criteria.checkIn,
    checkOut: criteria.checkOut,
    properties,
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
    path: '/offers/price',
    contentType: 'application/json',
    body: JSON.stringify({
      offer_ref: supplierRatePlanId,
      dates: { from: stay.checkIn, to: stay.checkOut },
    }),
  })
  if (!sent.ok) return sent

  const decoded = decodeJson(context('priceCheck'), sent.value, zephPriceResponse, errorCodeOf)
  if (!decoded.ok) return decoded

  const total = toMoney(decoded.value.payload.price, 'priceCheck')
  if (!total.ok) return total

  return ok({
    supplierRatePlanId: decoded.value.payload.offer_ref,
    total: total.value,
    changed: decoded.value.payload.changed,
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
    path: '/offers/hold',
    contentType: 'application/json',
    body: JSON.stringify({
      offer_ref: supplierRatePlanId,
      dates: { from: stay.checkIn, to: stay.checkOut },
      pax: guests,
    }),
  })
  if (!sent.ok) return sent

  const decoded = decodeJson(context('hold'), sent.value, zephHoldResponse, errorCodeOf)
  if (!decoded.ok) return decoded

  const total = toMoney(decoded.value.payload.price, 'hold')
  if (!total.ok) return total

  return ok({
    supplierHoldId: decoded.value.payload.hold_ref,
    expiresAt: decoded.value.payload.expires_at,
    total: total.value,
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
    body: JSON.stringify({
      hold_ref: supplierHoldId,
      guest: guest.fullName,
      request_id: idempotencyKey,
    }),
  })
  if (!sent.ok) return sent

  return toBooking(
    decodeJson(context('book'), sent.value, zephBookingResponse, errorCodeOf),
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
    path: `/bookings/${encode(bookingReference)}/cancel`,
  })
  if (!sent.ok) return sent

  const decoded = decodeJson(context('cancel'), sent.value, zephBookingResponse, errorCodeOf)
  return decoded.ok ? ok(undefined) : err(decoded.error)
}

async function lookup(
  http: SupplierHttp,
  path: string,
): Promise<Result<BookingResult, SupplierError>> {
  const sent = await http.send({ operation: 'getBooking', method: 'GET', path })
  if (!sent.ok) return sent

  return toBooking(
    decodeJson(context('getBooking'), sent.value, zephBookingResponse, errorCodeOf),
    'getBooking',
  )
}

function toBooking(
  decoded: Result<z.infer<typeof zephBookingResponse>, SupplierError>,
  operation: Operation,
): Result<BookingResult, SupplierError> {
  if (!decoded.ok) return decoded

  const total = toMoney(decoded.value.payload.price, operation)
  if (!total.ok) return total

  return ok({
    supplier: SUPPLIER,
    bookingReference: decoded.value.payload.ref,
    status: decoded.value.payload.state === 'confirmed' ? 'CONFIRMED' : 'CANCELLED',
    total: total.value,
    checkIn: decoded.value.payload.dates.from,
    checkOut: decoded.value.payload.dates.to,
  })
}

function toProperty(hotel: z.infer<typeof zephHotel>): Result<SupplierProperty, SupplierError> {
  const roomTypes = []

  for (const room of hotel.rooms) {
    const ratePlans = []

    for (const offer of room.offers) {
      const total = toMoney(offer.price, 'search')
      if (!total.ok) return total

      const nightly = toMoney(offer.nightly, 'search')
      if (!nightly.ok) return nightly

      ratePlans.push({
        supplierRatePlanId: offer.ref,
        // ZEPH tidak menamai rate plan-nya sama sekali. Nama dikosongkan
        // alih-alih dikarang dari sifat-sifatnya — search-service dapat
        // menyusun label sendiri dari `cancellationPolicy` dan
        // `breakfastIncluded`, dan label yang ia susun akan konsisten untuk
        // kelima supplier.
        name: '',
        total: total.value,
        nightly: nightly.value,
        cancellationPolicy: cancellationPolicy(offer.cancellable),
        breakfastIncluded: offer.breakfast,
        availability: { unitsLeft: offer.remaining },
      })
    }

    roomTypes.push({ supplierRoomTypeId: room.ref, name: room.name, ratePlans })
  }

  return ok({
    supplier: SUPPLIER,
    supplierPropertyId: hotel.ref,
    name: hotel.name,
    ...(hotel.rating === undefined ? {} : { starRating: hotel.rating }),
    amenities: [],
    roomTypes,
  })
}
