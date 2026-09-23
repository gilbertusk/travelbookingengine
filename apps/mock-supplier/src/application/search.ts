import { err, ok, type Result } from '@tbe/shared-kernel'
import { availableForStay, remainingUnits } from '../domain/availability.js'
import type { OperationFailure } from '../domain/booking.js'
import type { Property, RatePlan, RoomType } from '../domain/catalog.js'
import { nightlyPriceMinorIdr, stayTotalMinorIdr } from '../domain/pricing.js'
import { enumerateNights, validateStay } from '../domain/stay.js'
import { coversProperty, supplierPriceMultiplier, type SupplierCode } from '../domain/supplier.js'
import type { OperationDeps } from './ports.js'

export const MAX_PROPERTIES_PER_SEARCH = 25

export interface SearchRequest {
  readonly supplier: SupplierCode
  readonly city: string
  readonly checkIn: string
  readonly checkOut: string
  readonly guests: number
}

export interface RateOffer {
  readonly ratePlan: RatePlan
  readonly unitsLeft: number
  readonly nightlyMinorIdr: number
  readonly totalMinorIdr: number
}

export interface RoomOffer {
  readonly roomType: RoomType
  readonly rates: readonly RateOffer[]
}

export interface PropertyOffer {
  readonly property: Property
  readonly rooms: readonly RoomOffer[]
}

export function search(
  deps: OperationDeps,
  request: SearchRequest,
): Result<readonly PropertyOffer[], OperationFailure> {
  const problem = validateStay(request.checkIn, request.checkOut)
  if (problem !== undefined) return err({ kind: 'invalid_request', reason: problem })

  const nights = enumerateNights(request.checkIn, request.checkOut)

  const offers = deps.catalog
    .propertiesInCity(request.city)
    .filter((property) => coversProperty(request.supplier, property.id))
    .map((property) => buildPropertyOffer({ deps, request, property, nights }))
    .filter((offer): offer is PropertyOffer => offer !== undefined)
    .slice(0, MAX_PROPERTIES_PER_SEARCH)

  return ok(offers)
}

interface OfferContext {
  readonly deps: OperationDeps
  readonly request: SearchRequest
  readonly property: Property
  readonly nights: readonly string[]
}

function buildPropertyOffer(context: OfferContext): PropertyOffer | undefined {
  const rooms = context.deps.catalog
    .roomTypesOf(context.property.id)
    .filter((roomType) => roomType.maxGuests >= context.request.guests)
    .map((roomType) => buildRoomOffer(context, roomType))
    .filter((room): room is RoomOffer => room !== undefined)

  return rooms.length === 0 ? undefined : { property: context.property, rooms }
}

function buildRoomOffer(context: OfferContext, roomType: RoomType): RoomOffer | undefined {
  const rates = context.deps.catalog
    .ratePlansOf(roomType.id)
    .map((ratePlan) => buildRateOffer(context, ratePlan))
    .filter((rate): rate is RateOffer => rate !== undefined)

  return rates.length === 0 ? undefined : { roomType, rates }
}

function buildRateOffer(context: OfferContext, ratePlan: RatePlan): RateOffer | undefined {
  const unitsLeft = unitsLeftFor(context.deps, ratePlan.id, context.nights)
  if (unitsLeft <= 0) return undefined

  const multiplier = supplierPriceMultiplier(context.request.supplier, ratePlan.id)
  const firstNight = context.nights[0] ?? context.request.checkIn

  return {
    ratePlan,
    unitsLeft,
    nightlyMinorIdr: applyMultiplier(nightlyPriceMinorIdr(ratePlan, firstNight), multiplier),
    totalMinorIdr: applyMultiplier(stayTotalMinorIdr(ratePlan, context.nights), multiplier),
  }
}

export function unitsLeftFor(
  deps: OperationDeps,
  ratePlanId: string,
  nights: readonly string[],
): number {
  return availableForStay(nights, (date) =>
    remainingUnits(ratePlanId, date, deps.store.consumedUnits(ratePlanId, date)),
  )
}

export function applyMultiplier(minor: number, multiplier: number): number {
  return Math.round((minor * multiplier) / 100) * 100
}
