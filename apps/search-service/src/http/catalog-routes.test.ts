import { createLogger } from '@tbe/shared-kernel'
import request from 'supertest'
import { describe, expect, test } from 'vitest'
import { createSearchHttpApp } from '../composition/app.js'
import { createSnapshotHolder } from '../composition/snapshot-holder.js'
import { harness, mapping, property, sourceOf } from '../testing/fakes.js'
import type { UnmappedProperty } from '../domain/property.js'

/**
 * Antarmuka katalog.
 *
 * Dirangkai lewat factory yang sama dengan produksi — hanya port-nya yang
 * dipalsukan. Aplikasi uji yang dirangkai sendiri akan berbeda dari yang
 * sesungguhnya, dan perbedaannya selalu ada di tempat yang tidak diduga.
 */

const logger = createLogger({ serviceName: 'search-service-test', level: 'silent' })

const PADMA = property({ id: '018f0000-0000-7000-8000-000000000001' })
const KIRANA = property({
  id: '018f0000-0000-7000-8000-000000000002',
  slug: 'kirana-bandung-suites',
  name: 'Kirana Bandung Suites',
  city: 'Bandung',
})

const MAPPINGS = [mapping({ propertyId: PADMA.id })]

function pending(overrides: Partial<UnmappedProperty> = {}): UnmappedProperty {
  return {
    supplierId: 'ZEPH',
    supplierPropertyId: 'zeph-999',
    rawName: 'Padma Bali Boutique Htl.',
    rawCity: 'Bali',
    occurrences: 42,
    firstSeenAt: '2026-09-01T00:00:00.000Z',
    lastSeenAt: '2026-09-24T00:00:00.000Z',
    ...overrides,
  }
}

async function appWith(
  options: {
    readonly unmapped?: readonly UnmappedProperty[]
    readonly loaded?: boolean
  } = {},
) {
  const world = harness({
    properties: [PADMA, KIRANA],
    mappings: MAPPINGS,
    unmapped: options.unmapped ?? [],
  })

  const invalidations = { count: 0 }
  const holder = createSnapshotHolder({
    snapshots: world.deps.snapshots,
    source: sourceOf({ properties: [PADMA, KIRANA], mappings: MAPPINGS }),
    now: () => 0,
    onError: () => undefined,
  })

  if (options.loaded !== false) await holder.refresh()

  const { app } = createSearchHttpApp({
    deps: world.deps,
    holder,
    logger,
    serviceName: 'search-service',
    newId: () => '018f0000-0000-7000-8000-00000000000f',
    onCatalogChanged: async () => {
      invalidations.count += 1
      await Promise.resolve()
    },
  })

  return { app, world, invalidations, holder }
}

describe('autocomplete', () => {
  test('mengembalikan kota dan properti', async () => {
    const { app } = await appWith()

    const response = await request(app).get('/catalog/suggest?q=padma')

    expect(response.status).toBe(200)
    expect(response.body.data.properties[0].slug).toBe('padma-bali-boutique-hotel')
  })

  test('kota disertakan beserta jumlah propertinya', async () => {
    const { app } = await appWith()

    const response = await request(app).get('/catalog/suggest?q=bali')

    expect(response.body.data.cities[0]).toEqual({
      city: 'Bali',
      countryCode: 'ID',
      propertyCount: 1,
    })
  })

  test('kueri terlalu pendek dijawab kosong, bukan 400', async () => {
    // Pengguna sedang mengetik, bukan salah.
    const { app } = await appWith()

    const response = await request(app).get('/catalog/suggest?q=p')

    expect(response.status).toBe(200)
    expect(response.body.data).toEqual({ cities: [], properties: [] })
  })

  test('tanpa kueri sama sekali tetap 200', async () => {
    const response = await request((await appWith()).app).get('/catalog/suggest')

    expect(response.status).toBe(200)
  })

  test('batas di luar rentang ditolak', async () => {
    const response = await request((await appWith()).app).get('/catalog/suggest?q=bali&limit=500')

    expect(response.status).toBe(400)
  })
})

describe('halaman properti menurut slug', () => {
  test('dilayani dari snapshot', async () => {
    const { app, world } = await appWith()
    const before = world.properties.calls.reads

    const response = await request(app).get('/catalog/properties/padma-bali-boutique-hotel')

    expect(response.status).toBe(200)
    expect(response.body.data.name).toBe('Padma Bali Boutique Hotel')
    // Halaman ini dirender sisi server untuk mesin pencari; setiap perayapan
    // menjadi satu permintaan ke sini. Basis data tidak boleh ikut tersentuh.
    expect(world.properties.calls.reads).toBe(before)
  })

  test('membawa zona waktu properti', async () => {
    const response = await request((await appWith()).app).get(
      '/catalog/properties/padma-bali-boutique-hotel',
    )

    expect(response.body.data.timezone).toBe('Asia/Makassar')
  })

  test('slug yang tidak dikenal dibalas 404', async () => {
    const response = await request((await appWith()).app).get('/catalog/properties/tidak-ada')

    expect(response.status).toBe(404)
  })

  test('katalog yang belum termuat dibalas 404, bukan 500', async () => {
    const { app } = await appWith({ loaded: false })

    const response = await request(app).get('/catalog/properties/padma-bali-boutique-hotel')

    expect(response.status).toBe(404)
  })
})

describe('kesiapan', () => {
  test('tanpa katalog, service menyatakan diri belum siap', async () => {
    const { app } = await appWith({ loaded: false })

    const response = await request(app).get('/health/ready')

    expect(response.status).toBe(503)
  })

  test('dengan katalog, service menyatakan siap', async () => {
    const response = await request((await appWith()).app).get('/health/ready')

    expect(response.status).toBe(200)
  })
})

describe('antrian properti belum terpetakan', () => {
  test('dapat dilihat operator', async () => {
    const { app } = await appWith({ unmapped: [pending()] })

    const response = await request(app).get('/internal/catalog/unmapped')

    expect(response.status).toBe(200)
    expect(response.body.data[0].rawName).toBe('Padma Bali Boutique Htl.')
    expect(response.body.data[0].occurrences).toBe(42)
  })

  test('diurutkan menurut banyaknya kemunculan', async () => {
    // Yang paling sering muncul merugikan paling banyak pencarian, dan
    // memetakannya memberi hasil terbesar per menit kerja operator.
    const { app } = await appWith({
      unmapped: [
        pending({ supplierPropertyId: 'jarang', occurrences: 3 }),
        pending({ supplierPropertyId: 'sering', occurrences: 900 }),
      ],
    })

    const response = await request(app).get('/internal/catalog/unmapped')

    expect(response.body.data[0].supplierPropertyId).toBe('sering')
  })
})

describe('pemetaan manual ke properti yang sudah ada', () => {
  const body = {
    supplierId: 'ZEPH',
    supplierPropertyId: 'zeph-999',
    propertyId: PADMA.id,
  }

  test('berhasil dan mencatat operatornya', async () => {
    const { app, world } = await appWith({ unmapped: [pending()] })

    const response = await request(app)
      .post('/internal/catalog/unmapped/map')
      .set('x-tbe-user-id', 'operator-7')
      .send(body)

    expect(response.status).toBe(200)
    expect(world.mappings.rows.at(-1)?.mappedBy).toBe('operator-7')
  })

  test('membuang salinan katalog supaya perubahannya langsung terlihat', async () => {
    // Operator yang memetakan satu properti lalu tidak melihat perubahannya
    // akan memetakannya lagi.
    const { app, invalidations } = await appWith({ unmapped: [pending()] })

    await request(app).post('/internal/catalog/unmapped/map').send(body)

    expect(invalidations.count).toBe(1)
  })

  test('tanpa header identitas, pemetaannya dicatat tidak diketahui', async () => {
    const { app, world } = await appWith({ unmapped: [pending()] })

    await request(app).post('/internal/catalog/unmapped/map').send(body)

    expect(world.mappings.rows.at(-1)?.mappedBy).toBe('unknown')
  })

  test('baris antrian yang tidak ada dibalas 404', async () => {
    const { app } = await appWith()

    const response = await request(app).post('/internal/catalog/unmapped/map').send(body)

    expect(response.status).toBe(404)
  })

  test('properti tujuan yang tidak ada dibalas 404', async () => {
    const { app } = await appWith({ unmapped: [pending()] })

    const response = await request(app)
      .post('/internal/catalog/unmapped/map')
      .send({ ...body, propertyId: '018f0000-0000-7000-8000-0000000000ff' })

    expect(response.status).toBe(404)
  })

  test('pengenal properti yang bukan uuid ditolak 400', async () => {
    const { app } = await appWith({ unmapped: [pending()] })

    const response = await request(app)
      .post('/internal/catalog/unmapped/map')
      .send({ ...body, propertyId: 'bukan-uuid' })

    expect(response.status).toBe(400)
  })

  test('penolakan tidak membuang salinan katalog', async () => {
    const { app, invalidations } = await appWith()

    await request(app).post('/internal/catalog/unmapped/map').send(body)

    expect(invalidations.count).toBe(0)
  })
})

describe('membuat properti baru dari antrian', () => {
  const body = {
    supplierId: 'ZEPH',
    supplierPropertyId: 'zeph-999',
    name: 'Kirana Lombok Resort',
    city: 'Lombok',
    countryCode: 'ID',
    timezone: 'Asia/Makassar',
    latitude: -8.65,
    longitude: 116.32,
    starRating: 4,
  }

  test('properti tersimpan dan dibalas 201', async () => {
    const { app, world } = await appWith({ unmapped: [pending()] })

    const response = await request(app).post('/internal/catalog/unmapped/create').send(body)

    expect(response.status).toBe(201)
    expect(response.body.data.created).toBe(true)
    expect(world.properties.rows.some((row) => row.name === 'Kirana Lombok Resort')).toBe(true)
  })

  test('zona waktu wajib, bukan diberi bawaan diam-diam', async () => {
    // Bawaan `Asia/Jakarta` benar untuk sebagian besar properti dan salah
    // diam-diam untuk Bali dan luar negeri — lalu Step 25 menghitung tenggat
    // pembatalan dengan zona waktu yang keliru.
    const { app } = await appWith({ unmapped: [pending()] })
    const tanpaZona: Record<string, unknown> = { ...body }
    delete tanpaZona.timezone

    const response = await request(app).post('/internal/catalog/unmapped/create').send(tanpaZona)

    expect(response.status).toBe(400)
  })

  test('koordinat di luar rentang ditolak', async () => {
    const { app } = await appWith({ unmapped: [pending()] })

    const response = await request(app)
      .post('/internal/catalog/unmapped/create')
      .send({ ...body, latitude: 999 })

    expect(response.status).toBe(400)
  })

  test('slug yang bertabrakan dengan katalog mendapat angka pembeda', async () => {
    // Slug yang sudah terpakai diambil dari snapshot, bukan dari kueri
    // tersendiri.
    const { app, world } = await appWith({ unmapped: [pending()] })

    await request(app)
      .post('/internal/catalog/unmapped/create')
      .send({ ...body, name: 'Kirana Bandung Suites', city: 'Bandung' })

    const created = world.properties.rows.find((row) => row.id.endsWith('00f'))
    expect(created?.slug).toBe('kirana-bandung-suites-2')
  })

  test('baris antrian yang tidak ada dibalas 404', async () => {
    const { app } = await appWith()

    const response = await request(app).post('/internal/catalog/unmapped/create').send(body)

    expect(response.status).toBe(404)
  })
})
