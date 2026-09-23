import type { CatalogReader } from '../application/ports.js'
import {
  buildCatalog,
  type Catalog,
  type Property,
  type RatePlan,
  type RoomType,
} from '../domain/catalog.js'

/**
 * Katalog dibangun sekali saat startup lalu di-index untuk pencarian cepat.
 * Tanpa index, setiap pencarian memindai seluruh daftar rate plan dan latensi
 * tiruan jadi tercemar waktu pemindaian kita sendiri, bukan latensi yang
 * sengaja disimulasikan.
 */

export interface IndexedCatalog extends CatalogReader {
  readonly catalog: Catalog
}

export function createCatalogReader(catalog: Catalog = buildCatalog()): IndexedCatalog {
  const byCity = new Map<string, Property[]>()
  const propertyById = new Map<string, Property>()
  const roomTypesByProperty = new Map<string, RoomType[]>()
  const ratePlansByRoomType = new Map<string, RatePlan[]>()
  const ratePlanById = new Map<string, RatePlan>()

  for (const property of catalog.properties) {
    propertyById.set(property.id, property)
    pushInto(byCity, property.city.toLowerCase(), property)
  }

  for (const roomType of catalog.roomTypes) {
    pushInto(roomTypesByProperty, roomType.propertyId, roomType)
  }

  for (const ratePlan of catalog.ratePlans) {
    ratePlanById.set(ratePlan.id, ratePlan)
    pushInto(ratePlansByRoomType, ratePlan.roomTypeId, ratePlan)
  }

  return {
    catalog,
    allProperties: () => catalog.properties,
    allRatePlans: () => catalog.ratePlans,
    propertiesInCity: (city) => byCity.get(city.trim().toLowerCase()) ?? [],
    property: (propertyId) => propertyById.get(propertyId),
    roomTypesOf: (propertyId) => roomTypesByProperty.get(propertyId) ?? [],
    ratePlansOf: (roomTypeId) => ratePlansByRoomType.get(roomTypeId) ?? [],
    ratePlan: (ratePlanId) => ratePlanById.get(ratePlanId),
  }
}

function pushInto<T>(map: Map<string, T[]>, key: string, value: T): void {
  const existing = map.get(key)

  if (existing === undefined) map.set(key, [value])
  else existing.push(value)
}
