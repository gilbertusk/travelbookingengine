import { intBetween, pickOne, pickSome } from './deterministic.js'

/**
 * Katalog properti kanonik yang dibagi seluruh supplier.
 *
 * Katalog ini adalah kebenaran dasar: properti yang sama muncul di beberapa
 * supplier dengan pengenal, nama, dan harga berbeda. Itulah yang membuat
 * deduplikasi pada Step 13 punya sesuatu untuk dikerjakan, dan yang membuat
 * pemetaan pada Step 12b dapat dibangun dari data seed alih-alih ditebak.
 *
 * Nilai uang dinyatakan dalam satuan terkecil IDR. Konversi ke mata uang
 * supplier terjadi di lapisan HTTP, bukan di sini.
 */

export interface City {
  readonly name: string
  readonly countryCode: string
  readonly timezone: string
}

export interface Property {
  readonly id: string
  readonly name: string
  readonly city: string
  readonly countryCode: string
  readonly address: string
  readonly latitude: number
  readonly longitude: number
  readonly timezone: string
  readonly starRating: number
  readonly amenities: readonly string[]
  /**
   * Kontak properti untuk e-voucher (Step 23). Nomor dan surel karangan:
   * surel memakai domain `.example` (RFC 2606) supaya tidak pernah sampai ke
   * kotak surat sungguhan.
   */
  readonly phone: string
  readonly email: string
}

export interface RoomType {
  readonly id: string
  readonly propertyId: string
  readonly name: string
  readonly maxGuests: number
}

export interface RatePlan {
  readonly id: string
  readonly roomTypeId: string
  readonly propertyId: string
  readonly name: string
  readonly refundable: boolean
  readonly breakfastIncluded: boolean
  readonly basePriceMinorIdr: number
  readonly freeCancellationDays: number
}

export interface Catalog {
  readonly properties: readonly Property[]
  readonly roomTypes: readonly RoomType[]
  readonly ratePlans: readonly RatePlan[]
}

export const CITIES: readonly City[] = [
  { name: 'Bali', countryCode: 'ID', timezone: 'Asia/Makassar' },
  { name: 'Jakarta', countryCode: 'ID', timezone: 'Asia/Jakarta' },
  { name: 'Bandung', countryCode: 'ID', timezone: 'Asia/Jakarta' },
  { name: 'Yogyakarta', countryCode: 'ID', timezone: 'Asia/Jakarta' },
  { name: 'Surabaya', countryCode: 'ID', timezone: 'Asia/Jakarta' },
  { name: 'Singapore', countryCode: 'SG', timezone: 'Asia/Singapore' },
  { name: 'Kuala Lumpur', countryCode: 'MY', timezone: 'Asia/Kuala_Lumpur' },
  { name: 'Bangkok', countryCode: 'TH', timezone: 'Asia/Bangkok' },
]

export const PROPERTIES_PER_CITY = 40

const BRANDS = [
  'Amarta',
  'Bayu',
  'Cendana',
  'Dharma',
  'Ekawira',
  'Gayatri',
  'Harsa',
  'Indira',
  'Jayanti',
  'Kirana',
  'Laksmi',
  'Mahesa',
  'Narendra',
  'Padma',
  'Rangga',
  'Sanjaya',
  'Tirta',
  'Utara',
  'Wijaya',
  'Yudha',
]

const SUFFIXES = ['Hotel', 'Resort', 'Suites', 'Residence', 'Boutique Hotel', 'Grand Hotel']
const DIAL_CODES: Readonly<Record<string, string>> = { ID: '+62', SG: '+65', MY: '+60', TH: '+66' }

const STREETS = ['Jalan Melati', 'Jalan Cendrawasih', 'Jalan Kenanga', 'Jalan Anggrek']

const AMENITIES = [
  'wifi',
  'pool',
  'parking',
  'gym',
  'spa',
  'restaurant',
  'bar',
  'airport_shuttle',
  'family_rooms',
  'pet_friendly',
]

const ROOM_NAMES = ['Superior', 'Deluxe', 'Executive', 'Suite', 'Family Room']

const CITY_CENTERS: Readonly<Record<string, readonly [number, number]>> = {
  Bali: [-8.65, 115.216],
  Jakarta: [-6.2, 106.816],
  Bandung: [-6.914, 107.609],
  Yogyakarta: [-7.797, 110.37],
  Surabaya: [-7.257, 112.752],
  Singapore: [1.352, 103.819],
  'Kuala Lumpur': [3.139, 101.686],
  Bangkok: [13.756, 100.501],
}

function buildProperty(city: City, index: number): Property {
  const id = `prp_${city.name.toLowerCase().replace(/\s+/g, '')}_${String(index).padStart(3, '0')}`
  const center = CITY_CENTERS[city.name] ?? [0, 0]

  return {
    id,
    name: `${pickOne(BRANDS, id, 'brand')} ${city.name} ${pickOne(SUFFIXES, id, 'suffix')}`,
    city: city.name,
    countryCode: city.countryCode,
    address: `${pickOne(STREETS, id, 'street')} No. ${String(intBetween(1, 180, id, 'number'))}`,
    latitude: Number((center[0] + (fractionSigned(id, 'lat') * 12) / 100).toFixed(5)),
    longitude: Number((center[1] + (fractionSigned(id, 'lng') * 12) / 100).toFixed(5)),
    timezone: city.timezone,
    starRating: intBetween(2, 5, id, 'stars'),
    amenities: pickSome(AMENITIES, intBetween(3, 7, id, 'amenityCount'), id, 'amenities').sort(),
    phone: `${DIAL_CODES[city.countryCode] ?? '+62'} ${String(intBetween(200, 899, id, 'phoneArea'))} ${String(intBetween(1000, 9999, id, 'phoneLine'))}`,
    email: `reservasi@${id.replace(/_/g, '-')}.example`,
  }
}

function fractionSigned(...parts: readonly string[]): number {
  return intBetween(-100, 100, ...parts) / 100
}

function buildRoomTypes(property: Property): RoomType[] {
  const count = intBetween(2, 4, property.id, 'roomCount')

  return Array.from({ length: count }, (_unused, index) => {
    const id = `rmt_${property.id.slice(4)}_${String(index)}`
    return {
      id,
      propertyId: property.id,
      name: ROOM_NAMES[index] ?? `Room ${String(index + 1)}`,
      maxGuests: intBetween(2, 4, id, 'guests'),
    }
  })
}

function buildRatePlans(roomType: RoomType, property: Property): RatePlan[] {
  const count = intBetween(2, 3, roomType.id, 'rateCount')
  const nightlyBase = intBetween(35, 320, roomType.id, 'base') * 10_000

  return Array.from({ length: count }, (_unused, index) => {
    const id = `rpl_${roomType.id.slice(4)}_${String(index)}`
    const refundable = index === 0
    const breakfastIncluded = index !== 1

    return {
      id,
      roomTypeId: roomType.id,
      propertyId: property.id,
      name: rateName(refundable, breakfastIncluded),
      refundable,
      breakfastIncluded,
      // Tarif non-refundable lebih murah, dan sarapan menambah harga.
      basePriceMinorIdr: nightlyBase * (refundable ? 1 : 0.88) + (breakfastIncluded ? 75_000 : 0),
      freeCancellationDays: refundable ? intBetween(2, 7, id, 'cancelDays') : 0,
    }
  })
}

function rateName(refundable: boolean, breakfastIncluded: boolean): string {
  const bagian = [refundable ? 'Refundable' : 'Non-refundable']
  bagian.push(breakfastIncluded ? 'with Breakfast' : 'Room Only')
  return bagian.join(' ')
}

export function buildCatalog(): Catalog {
  const properties = CITIES.flatMap((city) =>
    Array.from({ length: PROPERTIES_PER_CITY }, (_unused, index) => buildProperty(city, index)),
  )
  const roomTypes = properties.flatMap(buildRoomTypes)
  const ratePlans = roomTypes.flatMap((roomType) => {
    const property = properties.find((candidate) => candidate.id === roomType.propertyId)
    return property === undefined ? [] : buildRatePlans(roomType, property)
  })

  return { properties, roomTypes, ratePlans }
}
