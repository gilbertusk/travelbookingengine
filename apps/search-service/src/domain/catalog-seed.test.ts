import { describe, expect, test } from 'vitest'
import { buildSeedPlan, seedSourceMappings, type GroundTruth } from './catalog-seed.js'
import { buildMappingTable, resolveProperty } from './mapping.js'

/**
 * Pembangunan katalog dari kebenaran dasar.
 *
 * Dua sifat yang dijaga: pemetaan menyatukan pengenal supplier yang berbeda ke
 * satu properti internal, dan menjalankannya dua kali tidak mengubah apa pun.
 */

const PADMA = {
  id: 'prp_bali_007',
  name: 'Padma Bali Boutique Hotel',
  city: 'Bali',
  countryCode: 'ID',
  address: 'Jalan Melati No. 12',
  latitude: -8.65,
  longitude: 115.216,
  timezone: 'Asia/Makassar',
  starRating: 4,
  amenities: ['pool', 'wifi'],
  offeredBy: [
    {
      supplier: 'SKY',
      supplierPropertyId: 'sky-120804930',
      supplierName: 'Padma Bali Boutique Hotel',
    },
    {
      supplier: 'NOVA',
      supplierPropertyId: 'nova-345515035',
      supplierName: 'PADMA BALI BOUTIQUE HOTEL',
    },
    {
      supplier: 'LUNA',
      supplierPropertyId: 'luna-338221784',
      supplierName: 'Hotel Padma Bali Boutique Hotel',
    },
  ],
}

const WIJAYA = {
  ...PADMA,
  id: 'prp_bali_011',
  name: 'Wijaya Bali Grand Hotel',
  offeredBy: [
    {
      supplier: 'ORBIT',
      supplierPropertyId: 'orbit-135144571',
      supplierName: 'Wijaya Bali Grand Hotel (Bali)',
    },
  ],
}

function truth(properties = [PADMA]): GroundTruth {
  return { properties }
}

function sequentialIds(): (sourceId: string) => string {
  // Pengenal yang dapat diramalkan supaya perbandingan antar pemanggilan
  // bermakna. uuid sungguhan akan membuat setiap uji idempotensi gagal karena
  // alasan yang bukan idempotensi.
  return (sourceId) => `uuid-${sourceId}`
}

describe('pemetaan menyatukan pengenal supplier yang berbeda', () => {
  test('tiga pengenal supplier menunjuk satu properti internal', () => {
    // Inilah FR-04 pada tingkat data: satu hotel fisik, tiga supplier, satu
    // entri. Tanpa ini, hasil pencarian menampilkan hotel yang sama tiga kali.
    const plan = buildSeedPlan(truth(), { newId: sequentialIds() })
    const table = buildMappingTable(plan.mappings)

    const sky = resolveProperty(table, 'SKY', 'sky-120804930')
    const nova = resolveProperty(table, 'NOVA', 'nova-345515035')
    const luna = resolveProperty(table, 'LUNA', 'luna-338221784')

    expect(sky.kind).toBe('mapped')
    if (sky.kind !== 'mapped' || nova.kind !== 'mapped' || luna.kind !== 'mapped') return

    expect(nova.propertyId).toBe(sky.propertyId)
    expect(luna.propertyId).toBe(sky.propertyId)
  })

  test('pengenal supplier yang tidak dikenal tidak terpetakan', () => {
    const plan = buildSeedPlan(truth(), { newId: sequentialIds() })
    const table = buildMappingTable(plan.mappings)

    expect(resolveProperty(table, 'SKY', 'sky-tidak-ada').kind).toBe('unmapped')
  })

  test('pengenal yang sama dari supplier berbeda tidak tertukar', () => {
    // Kunci pemetaan menggabungkan supplier dan pengenalnya. Kalau hanya
    // pengenalnya, dua supplier yang kebetulan memakai pengenal sama akan
    // saling menimpa.
    const plan = buildSeedPlan(
      truth([
        {
          ...PADMA,
          offeredBy: [{ supplier: 'SKY', supplierPropertyId: 'x-1', supplierName: 'A' }],
        },
        {
          ...WIJAYA,
          offeredBy: [{ supplier: 'NOVA', supplierPropertyId: 'x-1', supplierName: 'B' }],
        },
      ]),
      { newId: sequentialIds() },
    )
    const table = buildMappingTable(plan.mappings)

    const sky = resolveProperty(table, 'SKY', 'x-1')
    const nova = resolveProperty(table, 'NOVA', 'x-1')

    if (sky.kind !== 'mapped' || nova.kind !== 'mapped')
      throw new Error('keduanya harus terpetakan')
    expect(sky.propertyId).not.toBe(nova.propertyId)
  })

  test('seluruh pemetaan dari seed ditandai pasti', () => {
    const plan = buildSeedPlan(truth([PADMA, WIJAYA]), { newId: sequentialIds() })

    expect(plan.mappings.every((mapping) => mapping.confidence === 10_000)).toBe(true)
    expect(plan.mappings.every((mapping) => mapping.mappedBy === 'seed')).toBe(true)
  })
})

describe('properti yang dibangun', () => {
  test('membawa zona waktu', () => {
    // Step 25 menghitung tenggat pembatalan dengan zona waktu hotel.
    const plan = buildSeedPlan(truth(), { newId: sequentialIds() })

    expect(plan.properties[0]?.timezone).toBe('Asia/Makassar')
  })

  test('membawa kontak properti untuk e-voucher bila sumbernya menyebutkannya', () => {
    const withContact = { ...PADMA, phone: '+62 361 1234', email: 'reservasi@padma.example' }

    const plan = buildSeedPlan(truth([withContact]), { newId: sequentialIds() })

    expect(plan.properties[0]).toMatchObject({
      phone: '+62 361 1234',
      email: 'reservasi@padma.example',
    })
  })

  test('sumber tanpa kontak menghasilkan properti tanpa kontak, bukan string kosong', () => {
    const plan = buildSeedPlan(truth(), { newId: sequentialIds() })

    expect(plan.properties[0]).not.toHaveProperty('phone')
    expect(plan.properties[0]).not.toHaveProperty('email')
  })

  test('membawa nama yang dinormalkan untuk pencocokan manual', () => {
    const plan = buildSeedPlan(truth(), { newId: sequentialIds() })

    expect(plan.properties[0]?.normalizedName).toBe('padma bali boutique hotel')
  })

  test('slug tidak mengulang kota yang sudah ada di nama', () => {
    const plan = buildSeedPlan(truth(), { newId: sequentialIds() })

    expect(plan.properties[0]?.slug).toBe('padma-bali-boutique-hotel')
  })

  test('slug tetap unik untuk properti yang namanya sama', () => {
    const plan = buildSeedPlan(truth([PADMA, { ...PADMA, id: 'prp_bali_099' }]), {
      newId: sequentialIds(),
    })

    const slugs = plan.properties.map((property) => property.slug)

    expect(new Set(slugs).size).toBe(2)
    expect(slugs[1]).toBe('padma-bali-boutique-hotel-2')
  })

  test('tidak membawa harga maupun ketersediaan', () => {
    // Batas yang menjaga premis project. Ditegakkan juga pada skema oleh
    // `pnpm verify:catalog`; di sini dijaga pada bentuk datanya.
    const plan = buildSeedPlan(truth(), { newId: sequentialIds() })
    const keys = Object.keys(plan.properties[0] ?? {})

    for (const forbidden of ['price', 'rate', 'availability', 'currency', 'amount']) {
      expect(keys.some((key) => key.toLowerCase().includes(forbidden))).toBe(false)
    }
  })
})

describe('idempotensi', () => {
  test('dijalankan dua kali menghasilkan rencana yang sama persis', () => {
    const first = buildSeedPlan(truth([PADMA, WIJAYA]), { newId: sequentialIds() })
    const second = buildSeedPlan(truth([PADMA, WIJAYA]), { newId: sequentialIds() })

    expect(second).toEqual(first)
  })

  test('properti yang sudah ada memakai pengenal dan slug lamanya', () => {
    const first = buildSeedPlan(truth([PADMA]), { newId: sequentialIds() })
    const existing = new Map([['prp_bali_007', { id: 'id-lama', slug: 'slug-lama' }]])

    const second = buildSeedPlan(truth([PADMA]), { newId: sequentialIds(), existing })

    expect(first.properties[0]?.slug).toBe('padma-bali-boutique-hotel')
    expect(second.properties[0]?.id).toBe('id-lama')
    expect(second.properties[0]?.slug).toBe('slug-lama')
  })

  test('nama yang berubah memperbarui nama tetapi TIDAK slug', () => {
    // Sifat yang paling penting di berkas ini. Hotel berganti merek, supplier
    // memperbaiki ejaan — dan setiap URL yang sudah terindeks tetap hidup.
    const existing = new Map([
      ['prp_bali_007', { id: 'id-lama', slug: 'padma-bali-boutique-hotel' }],
    ])

    const renamed = buildSeedPlan(truth([{ ...PADMA, name: 'Padma Bali Grand Resort' }]), {
      newId: sequentialIds(),
      existing,
    })

    expect(renamed.properties[0]?.name).toBe('Padma Bali Grand Resort')
    expect(renamed.properties[0]?.slug).toBe('padma-bali-boutique-hotel')
  })

  test('properti baru pada seed berikutnya tidak bertabrakan dengan slug lama', () => {
    const existing = new Map([
      ['prp_bali_007', { id: 'id-lama', slug: 'padma-bali-boutique-hotel' }],
    ])

    const plan = buildSeedPlan(truth([PADMA, { ...PADMA, id: 'prp_bali_099' }]), {
      newId: sequentialIds(),
      existing,
    })

    expect(plan.properties[1]?.slug).toBe('padma-bali-boutique-hotel-2')
  })
})

describe('penanda sumber seed', () => {
  test('menghubungkan properti internal dengan pengenal mock-supplier', () => {
    // Inilah yang dibaca seed berikutnya untuk mengenali properti yang sudah
    // ada. Disimpan sebagai pemetaan supplier semu, bukan kolom di tabel
    // properti — pengenal mock-supplier tidak punya arti di produksi.
    const plan = buildSeedPlan(truth([PADMA, WIJAYA]), { newId: sequentialIds() })
    const sources = seedSourceMappings(truth([PADMA, WIJAYA]), plan)

    expect(sources).toHaveLength(2)
    expect(sources[0]?.supplierId).toBe('seed')
    expect(sources[0]?.supplierPropertyId).toBe('prp_bali_007')
    expect(sources[0]?.propertyId).toBe(plan.properties[0]?.id)
  })
})
