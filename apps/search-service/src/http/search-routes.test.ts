import { createLogger } from '@tbe/shared-kernel'
import request from 'supertest'
import { describe, expect, test } from 'vitest'
import { createSearchHttpApp } from '../composition/app.js'
import { createSnapshotHolder } from '../composition/snapshot-holder.js'
import { createSightingBuffer } from '../application/resolve-properties.js'
import { harness, mapping, sourceOf } from '../testing/fakes.js'
import {
  CATALOG,
  PADMA,
  WIJAYA,
  manualDeadline,
  searchHarness,
  supplierProperty,
  type SearchHarness,
} from '../testing/search-fakes.js'

/**
 * Antarmuka pencarian.
 *
 * Dirangkai lewat factory yang sama dengan produksi — hanya port-nya yang
 * dipalsukan. Yang diuji di sini adalah hal-hal yang hanya ada di lapisan
 * HTTP: validasi kriteria, bentuk jawaban, dan status galatnya.
 */

const logger = createLogger({ serviceName: 'search-service-test', level: 'silent' })

/** Jauh setelah `today` di harness, supaya kriterianya selalu sah. */
const STAY = { checkIn: '2026-11-10', checkOut: '2026-11-12' }

const MAPPINGS = [
  mapping({ supplierId: 'SKY', supplierPropertyId: 'sky-padma', propertyId: PADMA.id }),
  mapping({ supplierId: 'SKY', supplierPropertyId: 'sky-wijaya', propertyId: WIJAYA.id }),
]

async function appWith(world: SearchHarness) {
  const catalog = harness({ properties: [PADMA, WIJAYA], mappings: MAPPINGS })
  const holder = createSnapshotHolder({
    snapshots: catalog.deps.snapshots,
    source: sourceOf({ properties: [PADMA, WIJAYA], mappings: MAPPINGS }),
    now: () => 0,
    onError: () => undefined,
  })
  await holder.refresh()

  const { app } = createSearchHttpApp({
    deps: catalog.deps,
    search: { ...world.deps, catalog: () => CATALOG },
    deadline: manualDeadline().factory,
    sightings: createSightingBuffer(),
    onLateError: () => undefined,
    holder,
    logger,
    serviceName: 'search-service',
    newId: () => '018f0000-0000-7000-8000-00000000000f',
    onCatalogChanged: async () => {
      await Promise.resolve()
    },
  })

  return app
}

function world() {
  return searchHarness({
    scripts: {
      SKY: {
        kind: 'responds',
        properties: [
          supplierProperty('sky-padma', 1_000_000),
          supplierProperty('sky-wijaya', 700_000),
        ],
      },
    },
  })
}

function query(overrides: Record<string, string> = {}): string {
  return new URLSearchParams({ city: 'Bali', ...STAY, guests: '2', ...overrides }).toString()
}

describe('pencarian', () => {
  test('mengembalikan hasil beserta metadatanya', async () => {
    const app = await appWith(world())

    const response = await request(app).get(`/search?${query()}`)

    expect(response.status).toBe(200)
    expect(response.body.data.properties).toHaveLength(2)
    expect(response.body.data.meta.source).toBe('live')
  })

  test('harga yang dikembalikan adalah harga jual', async () => {
    // Rp 1.000.000 × 1,2 = Rp 1.200.000 ; × 1,11 = Rp 1.332.000
    const app = await appWith(world())

    const response = await request(app).get(`/search?${query({ sort: 'price' })}`)
    const padma = response.body.data.properties.find(
      (item: { ref: string }) => item.ref === PADMA.id,
    )

    expect(padma.lowestTotal.amountMinor).toBe(1_332_000)
  })

  test('metadata menyebut supplier yang menjawab', async () => {
    const app = await appWith(world())

    const response = await request(app).get(`/search?${query()}`)

    expect(response.body.data.meta.suppliersResponded).toEqual(['SKY'])
    expect(response.body.data.meta.partial).toBe(false)
  })

  test('supplier yang mati membuat hasilnya ditandai parsial', async () => {
    const app = await appWith(
      searchHarness({
        scripts: {
          SKY: { kind: 'responds', properties: [supplierProperty('sky-padma')] },
          ZEPH: { kind: 'fails' },
        },
      }),
    )

    const response = await request(app).get(`/search?${query()}`)

    expect(response.body.data.meta.partial).toBe(true)
    expect(response.body.data.meta.suppliersUnavailable).toEqual(['ZEPH'])
  })
})

describe('validasi kriteria', () => {
  test('tanggal keluar sebelum tanggal masuk ditolak', async () => {
    const app = await appWith(world())

    const response = await request(app).get(
      `/search?${query({ checkIn: '2026-11-12', checkOut: '2026-11-10' })}`,
    )

    expect(response.status).toBe(400)
    expect(response.body.error.details.problem).toBe('checkout_not_after_checkin')
  })

  test('tanggal masuk di masa lampau ditolak', async () => {
    const app = await appWith(world())

    const response = await request(app).get(
      `/search?${query({ checkIn: '2020-01-01', checkOut: '2020-01-03' })}`,
    )

    expect(response.body.error.details.problem).toBe('check_in_in_past')
  })

  test('menginap terlalu lama ditolak', async () => {
    const app = await appWith(world())

    const response = await request(app).get(
      `/search?${query({ checkIn: '2026-11-10', checkOut: '2026-12-20' })}`,
    )

    expect(response.body.error.details.problem).toBe('stay_too_long')
  })

  test('tanggal terlalu jauh ke depan ditolak', async () => {
    const app = await appWith(world())

    const response = await request(app).get(
      `/search?${query({ checkIn: '2029-01-01', checkOut: '2029-01-03' })}`,
    )

    expect(response.body.error.details.problem).toBe('too_far_ahead')
  })

  test('jumlah tamu di luar batas ditolak', async () => {
    const app = await appWith(world())

    expect((await request(app).get(`/search?${query({ guests: '99' })}`)).status).toBe(400)
    expect((await request(app).get(`/search?${query({ guests: '0' })}`)).status).toBe(400)
  })

  test('tanggal yang bukan tanggal kalender ditolak', async () => {
    const app = await appWith(world())

    const response = await request(app).get(`/search?${query({ checkIn: '10-11-2026' })}`)

    expect(response.status).toBe(400)
  })

  test('kota wajib ada', async () => {
    const app = await appWith(world())

    const response = await request(app).get(`/search?checkIn=2026-11-10&checkOut=2026-11-12`)

    expect(response.status).toBe(400)
  })

  test('urutan yang tidak dikenal ditolak', async () => {
    const app = await appWith(world())

    expect((await request(app).get(`/search?${query({ sort: 'termurah' })}`)).status).toBe(400)
  })

  test('permintaan yang ditolak tidak memanggil satu pun supplier', async () => {
    // Setiap permintaan yang lolos memicu fan-out ke lima supplier. Permintaan
    // yang keliru tidak boleh menghabiskan anggaran siapa pun.
    const scenario = world()
    const app = await appWith(scenario)

    await request(app).get(`/search?${query({ checkIn: '2020-01-01', checkOut: '2020-01-03' })}`)

    expect(scenario.suppliers.searched.size).toBe(0)
  })
})

describe('bendera boolean dari query string', () => {
  test('`false` berarti mati, bukan menyala', async () => {
    // `z.coerce.boolean()` akan menjadikan string 'false' bernilai true, dan
    // penyaringnya menyala diam-diam. Yang mengeluhkannya adalah pengguna
    // yang tidak menemukan hotelnya.
    const app = await appWith(
      searchHarness({
        scripts: {
          SKY: {
            kind: 'responds',
            properties: [
              supplierProperty('sky-padma', 1_000_000, {
                roomTypes: [
                  {
                    supplierRoomTypeId: 'rt',
                    name: 'Deluxe',
                    ratePlans: [
                      {
                        supplierRatePlanId: 'rp',
                        name: 'Non-refundable Room Only',
                        total: { amountMinor: 1_000_000, currency: 'IDR' },
                        nightly: { amountMinor: 500_000, currency: 'IDR' },
                        cancellationPolicy: { refundable: false },
                        breakfastIncluded: false,
                        availability: { unitsLeft: 3 },
                      },
                    ],
                  },
                ],
              }),
            ],
          },
        },
      }),
    )

    const off = await request(app).get(`/search?${query({ refundableOnly: 'false' })}`)

    expect(off.body.data.properties).toHaveLength(1)
  })

  test('`true` benar-benar menyaring', async () => {
    const app = await appWith(
      searchHarness({
        scripts: {
          SKY: {
            kind: 'responds',
            properties: [
              supplierProperty('sky-padma', 1_000_000, {
                roomTypes: [
                  {
                    supplierRoomTypeId: 'rt',
                    name: 'Deluxe',
                    ratePlans: [
                      {
                        supplierRatePlanId: 'rp',
                        name: 'Non-refundable Room Only',
                        total: { amountMinor: 1_000_000, currency: 'IDR' },
                        nightly: { amountMinor: 500_000, currency: 'IDR' },
                        cancellationPolicy: { refundable: false },
                        breakfastIncluded: false,
                        availability: { unitsLeft: 3 },
                      },
                    ],
                  },
                ],
              }),
            ],
          },
        },
      }),
    )

    const on = await request(app).get(`/search?${query({ refundableOnly: 'true' })}`)

    expect(on.body.data.properties).toEqual([])
  })
})

describe('detail satu properti', () => {
  test('mengembalikan seluruh tawaran properti itu', async () => {
    const app = await appWith(world())

    const response = await request(app).get(`/search/properties/${PADMA.id}?${query()}`)

    expect(response.status).toBe(200)
    expect(response.body.data.property.ref).toBe(PADMA.id)
    expect(response.body.data.property.offers).toHaveLength(1)
  })

  test('dapat dicari lewat slug permanennya', async () => {
    // Inilah URL yang diindeks mesin pencari.
    const app = await appWith(world())

    const response = await request(app).get(`/search/properties/${PADMA.slug}?${query()}`)

    expect(response.status).toBe(200)
    expect(response.body.data.property.slug).toBe(PADMA.slug)
  })

  test('properti yang tidak ada di hasil dibalas 404', async () => {
    const app = await appWith(world())

    const response = await request(app).get(`/search/properties/tidak-ada?${query()}`)

    expect(response.status).toBe(404)
  })

  test('kriteria tetap wajib — harga hanya bermakna untuk rentang tanggal', async () => {
    const app = await appWith(world())

    const response = await request(app).get(`/search/properties/${PADMA.id}`)

    expect(response.status).toBe(400)
  })

  test('metadata ikut dikembalikan', async () => {
    const app = await appWith(world())

    const response = await request(app).get(`/search/properties/${PADMA.id}?${query()}`)

    expect(response.body.data.meta.suppliersResponded).toEqual(['SKY'])
  })
})

describe('pembatalan cache oleh operasi', () => {
  test('membuang hasil satu kota', async () => {
    const scenario = world()
    const app = await appWith(scenario)

    await request(app).get(`/search?${query()}`)

    const response = await request(app).post('/internal/search/invalidate').send({ city: 'Bali' })

    expect(response.status).toBe(200)
    expect(response.body.data.removed).toBe(1)
  })

  test('nama kota dinormalkan sebelum dicocokkan', async () => {
    const scenario = world()
    const app = await appWith(scenario)

    await request(app).get(`/search?${query()}`)

    const response = await request(app)
      .post('/internal/search/invalidate')
      .send({ city: '  BALI ' })

    expect(response.body.data.removed).toBe(1)
  })

  test('kota tanpa hasil tersimpan membuang nol, bukan galat', async () => {
    const app = await appWith(world())

    const response = await request(app).post('/internal/search/invalidate').send({ city: 'Lombok' })

    expect(response.status).toBe(200)
    expect(response.body.data.removed).toBe(0)
  })

  test('tanpa kota ditolak', async () => {
    const app = await appWith(world())

    expect((await request(app).post('/internal/search/invalidate').send({})).status).toBe(400)
  })
})
