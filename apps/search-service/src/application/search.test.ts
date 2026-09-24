import { describe, expect, test } from 'vitest'
import { search, type SearchResponse } from './search.js'
import { createSightingBuffer } from './resolve-properties.js'
import { resultCacheKey, supplierCacheKey, type SearchCriteria } from '../domain/criteria.js'
import {
  manualDeadline,
  searchHarness,
  supplierProperty,
  type SearchHarness,
} from '../testing/search-fakes.js'

/**
 * Orkestrator pencarian.
 *
 * Seluruh berkas ini dikendalikan tangan: anggaran waktu dihabiskan ketika
 * pengujian memutuskannya, dan supplier yang menggantung dilepas ketika
 * pengujian memutuskannya. Tidak ada `setTimeout`, tidak ada pengukuran waktu.
 */

function criteria(overrides: Partial<SearchCriteria> = {}): SearchCriteria {
  return {
    city: 'Bali',
    checkIn: '2026-11-10',
    checkOut: '2026-11-12',
    guests: 2,
    sort: 'relevance',
    amenities: [],
    refundableOnly: false,
    breakfastIncluded: false,
    ...overrides,
  }
}

function options(deadline: ReturnType<typeof manualDeadline>) {
  return {
    deadline: deadline.factory,
    sightings: createSightingBuffer(),
    onLateError: () => undefined,
  }
}

/** Menjalankan pencarian yang seluruh supplier-nya menjawab seketika. */
async function run(
  world: SearchHarness,
  overrides: Partial<SearchCriteria> = {},
): Promise<SearchResponse> {
  return await search(world.deps, criteria(overrides), options(manualDeadline()))
}

/**
 * Menunggu sampai sebuah keadaan tercapai, lewat microtask — bukan lewat waktu.
 *
 * Rantai `await` di jalur pencarian panjang: baca cache, panggil supplier,
 * tulis cache, tandai hasilnya. Menghitung berapa tick yang dibutuhkan berarti
 * menuliskan detail implementasi ke dalam uji, dan uji itu akan patah setiap
 * kali satu `await` ditambahkan. Menunggu KEADAANNYA tidak patah, dan gagal
 * dengan pesan yang jelas bila keadaannya tidak pernah datang.
 */
async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let index = 0; index < 2_000; index += 1) {
    if (predicate()) return
    await Promise.resolve()
  }

  throw new Error(`keadaan tidak pernah tercapai: ${label}`)
}

describe('satu supplier lambat', () => {
  test('hasil tetap kembali dalam anggaran waktu', async () => {
    // Anggaran TIDAK perlu dihabiskan kalau ada yang menjawab — tetapi di
    // sini LUNA menggantung, jadi anggarannyalah yang menyelesaikan balapan.
    // Kalau pencarian menunggu LUNA, uji ini akan menggantung selamanya.
    const world = searchHarness({
      scripts: {
        SKY: { kind: 'responds', properties: [supplierProperty('sky-padma')] },
        LUNA: { kind: 'hangs' },
      },
    })
    const deadline = manualDeadline()

    const running = search(world.deps, criteria(), options(deadline))
    await until(() => world.supplierResults.calls.writes >= 1, 'SKY menjawab')
    deadline.expire()

    const response = await running

    expect(response.properties).toHaveLength(1)
    expect(response.meta.suppliersResponded).toEqual(['SKY'])
    expect(response.meta.suppliersTimedOut).toEqual(['LUNA'])
  })

  test('hasilnya ditandai parsial', async () => {
    const world = searchHarness({
      scripts: {
        SKY: { kind: 'responds', properties: [supplierProperty('sky-padma')] },
        LUNA: { kind: 'hangs' },
      },
    })
    const deadline = manualDeadline()

    const running = search(world.deps, criteria(), options(deadline))
    await until(() => world.supplierResults.calls.writes >= 1, 'SKY menjawab')
    deadline.expire()

    expect((await running).meta.partial).toBe(true)
  })

  test('hasil supplier lambat masuk cache dan muncul pada pencarian berikutnya', async () => {
    // Inilah butir terakhir US-01, dan detail yang membedakan implementasi
    // serius dari yang asal jalan. Tanpa ini, LUNA tidak pernah berkontribusi
    // sama sekali dan inventarisnya hilang selamanya dari hasil pencarian.
    const world = searchHarness({
      scripts: {
        SKY: { kind: 'responds', properties: [supplierProperty('sky-padma')] },
        LUNA: { kind: 'hangs' },
      },
    })
    const deadline = manualDeadline()

    const running = search(world.deps, criteria(), options(deadline))
    await until(() => world.supplierResults.calls.writes >= 1, 'SKY menjawab')
    deadline.expire()
    const first = await running

    expect(first.meta.suppliersResponded).toEqual(['SKY'])

    // LUNA akhirnya menjawab, jauh setelah pencariannya dikembalikan.
    world.suppliers.release('LUNA', [supplierProperty('luna-padma', 800_000)])
    await until(
      () => world.supplierResults.entries.has(supplierCacheKey('LUNA', criteria())),
      'jawaban LUNA tersimpan',
    )

    // Pencarian berikutnya — cache hasil dibuang lebih dulu supaya yang diuji
    // adalah cache lapis KEDUA, bukan lapis pertama.
    world.results.entries.clear()
    const second = await run(world)

    expect(second.meta.suppliersResponded).toContain('LUNA')
    // Padma kini punya dua tawaran: SKY dan LUNA, dan LUNA lebih murah.
    expect(second.properties[0]?.offers).toHaveLength(2)
    expect(second.properties[0]?.offers[0]?.supplier).toBe('LUNA')
  })

  test('supplier lambat tidak dipanggil ulang pada pencarian berikutnya', async () => {
    const world = searchHarness({
      scripts: {
        SKY: { kind: 'responds', properties: [supplierProperty('sky-padma')] },
        LUNA: { kind: 'hangs' },
      },
    })
    const deadline = manualDeadline()

    const running = search(world.deps, criteria(), options(deadline))
    await until(() => world.supplierResults.calls.writes >= 1, 'SKY menjawab')
    deadline.expire()
    await running

    world.suppliers.release('LUNA', [supplierProperty('luna-padma')])
    await until(
      () => world.supplierResults.entries.has(supplierCacheKey('LUNA', criteria())),
      'jawaban LUNA tersimpan',
    )

    world.results.entries.clear()
    await run(world)

    // Sekali pada pencarian pertama, dan jawabannya dipakai lagi dari cache.
    expect(world.suppliers.searched.get('LUNA')).toBe(1)
  })
})

describe('satu supplier mati', () => {
  test('hasil tetap kembali dan metadata menandainya', async () => {
    const world = searchHarness({
      scripts: {
        SKY: { kind: 'responds', properties: [supplierProperty('sky-padma')] },
        ZEPH: { kind: 'fails', message: 'connection reset' },
      },
    })

    const response = await run(world)

    expect(response.properties).toHaveLength(1)
    expect(response.meta.suppliersUnavailable).toEqual(['ZEPH'])
    expect(response.meta.partial).toBe(true)
  })

  test('pemutus sirkuit terbuka dilewati tanpa dipanggil', async () => {
    // Bukan dipanggil lalu ditolak cepat, melainkan tidak dipanggil sama
    // sekali. Supplier yang sudah terbukti tumbang tidak layak menghabiskan
    // satu slot anggaran pun.
    const world = searchHarness({
      scripts: {
        SKY: { kind: 'responds', properties: [supplierProperty('sky-padma')] },
        LUNA: { kind: 'hangs' },
      },
      statuses: [
        { supplier: 'SKY', isActive: true, circuit: 'closed' },
        { supplier: 'LUNA', isActive: true, circuit: 'open' },
      ],
    })

    const response = await run(world)

    expect(world.suppliers.searched.has('LUNA')).toBe(false)
    expect(response.meta.suppliersUnavailable).toEqual(['LUNA'])
  })

  test('supplier nonaktif juga dilewati', async () => {
    const world = searchHarness({
      scripts: {
        SKY: { kind: 'responds', properties: [supplierProperty('sky-padma')] },
        ORBIT: { kind: 'hangs' },
      },
      statuses: [
        { supplier: 'SKY', isActive: true, circuit: 'closed' },
        { supplier: 'ORBIT', isActive: false, circuit: 'closed' },
      ],
    })

    await run(world)

    expect(world.suppliers.searched.has('ORBIT')).toBe(false)
  })

  test('seluruh supplier mati menghasilkan hasil kosong, bukan galat', async () => {
    const world = searchHarness({
      scripts: { SKY: { kind: 'fails' }, ZEPH: { kind: 'fails' } },
    })

    const response = await run(world)

    expect(response.properties).toEqual([])
    expect(response.meta.suppliersUnavailable).toHaveLength(2)
  })
})

describe('deduplikasi lintas supplier', () => {
  test('properti sama dari tiga supplier menjadi satu entri', async () => {
    const world = searchHarness({
      scripts: {
        SKY: { kind: 'responds', properties: [supplierProperty('sky-padma', 1_200_000)] },
        NOVA: { kind: 'responds', properties: [supplierProperty('nova-padma', 1_000_000)] },
        LUNA: { kind: 'responds', properties: [supplierProperty('luna-padma', 1_400_000)] },
      },
    })

    const response = await run(world)

    expect(response.properties).toHaveLength(1)
    expect(response.properties[0]?.suppliers).toHaveLength(3)
    expect(response.properties[0]?.offers).toHaveLength(3)
  })

  test('harga terendah yang ditampilkan, seluruh tawaran tetap tersimpan', async () => {
    const world = searchHarness({
      scripts: {
        SKY: { kind: 'responds', properties: [supplierProperty('sky-padma', 1_200_000)] },
        NOVA: { kind: 'responds', properties: [supplierProperty('nova-padma', 1_000_000)] },
      },
    })

    const response = await run(world)

    // Rp 1.000.000 × 1,2 = Rp 1.200.000 ; × 1,11 = Rp 1.332.000
    expect(response.properties[0]?.lowestTotal.amountMinor).toBe(1_332_000)
    expect(response.properties[0]?.offers).toHaveLength(2)
  })

  test('properti belum terpetakan tetap muncul dan masuk antrian', async () => {
    const world = searchHarness({
      scripts: {
        ZEPH: { kind: 'responds', properties: [supplierProperty('zeph-baru')] },
      },
    })
    const sightings = createSightingBuffer()

    const response = await search(world.deps, criteria(), {
      deadline: manualDeadline().factory,
      sightings,
      onLateError: () => undefined,
    })

    expect(response.properties).toHaveLength(1)
    expect(response.properties[0]?.mapped).toBe(false)
    expect(response.properties[0]?.slug).toBeUndefined()
    expect(sightings.size).toBe(1)
  })
})

describe('penetapan harga', () => {
  test('dilakukan dalam SATU panggilan untuk seluruh hasil', async () => {
    // Satu panggilan untuk ratusan tawaran, bukan satu panggilan per tawaran.
    // Yang kedua menghasilkan ratusan perjalanan jaringan di jalur yang paling
    // sensitif terhadap waktu.
    const world = searchHarness({
      scripts: {
        SKY: {
          kind: 'responds',
          properties: [supplierProperty('sky-padma'), supplierProperty('sky-wijaya')],
        },
        NOVA: { kind: 'responds', properties: [supplierProperty('nova-padma')] },
      },
    })

    await run(world)

    expect(world.pricing.calls.count).toBe(1)
    expect(world.pricing.calls.items).toEqual([3])
  })

  test('harga yang dikembalikan SELALU harga jual, bukan harga supplier', async () => {
    const world = searchHarness({
      scripts: {
        SKY: { kind: 'responds', properties: [supplierProperty('sky-padma', 1_000_000)] },
      },
    })

    const response = await run(world)
    const offer = response.properties[0]?.offers[0]

    expect(offer?.total.amountMinor).toBe(1_332_000)
    expect(offer?.total.amountMinor).not.toBe(1_000_000)
  })

  test('rincian harga ikut dikembalikan untuk transparansi biaya', async () => {
    // DESIGN-SYSTEM.md mewajibkannya pada komponen PriceDisplay.
    const world = searchHarness({
      scripts: {
        SKY: { kind: 'responds', properties: [supplierProperty('sky-padma', 1_000_000)] },
      },
    })

    const offer = (await run(world)).properties[0]?.offers[0]

    expect(offer?.base.amountMinor).toBe(1_000_000)
    expect(offer?.markup.amountMinor).toBe(200_000)
    expect(offer?.tax.amountMinor).toBe(132_000)
    expect(offer?.taxName).toBe('PPN')
  })

  test('harga supplier tidak bocor ke klien', async () => {
    const world = searchHarness({
      scripts: { SKY: { kind: 'responds', properties: [supplierProperty('sky-padma')] } },
    })

    const offer = (await run(world)).properties[0]?.offers[0]

    expect(Object.keys(offer ?? {})).not.toContain('supplierTotal')
  })

  test('tawaran yang gagal dihitung harganya dibuang, bukan dikembalikan apa adanya', async () => {
    // Menampilkan harga supplier berarti menjual tanpa markup.
    const world = searchHarness({
      scripts: {
        SKY: {
          kind: 'responds',
          properties: [supplierProperty('sky-padma'), supplierProperty('sky-wijaya')],
        },
      },
    })
    world.pricing.dropRef('prop-wijaya|SKY|sky-wijaya-rp')

    const response = await run(world)

    expect(response.properties.map((item) => item.ref)).toEqual(['prop-padma'])
  })

  test('tanpa hasil, pricing-service tidak dipanggil sama sekali', async () => {
    const world = searchHarness({ scripts: { SKY: { kind: 'responds', properties: [] } } })

    await run(world)

    expect(world.pricing.calls.count).toBe(0)
  })
})

describe('cache lapis pertama', () => {
  test('pencarian kedua dilayani dari cache tanpa memanggil supplier', async () => {
    const world = searchHarness({
      scripts: { SKY: { kind: 'responds', properties: [supplierProperty('sky-padma')] } },
    })

    await run(world)
    const second = await run(world)

    expect(world.suppliers.searched.get('SKY')).toBe(1)
    expect(second.meta.source).toBe('cache')
  })

  test('respons dari cache menandai dirinya beserta umurnya', async () => {
    // Klien yang tidak tahu datanya berumur empat menit tidak dapat
    // memutuskan apa pun tentangnya.
    const world = searchHarness({
      scripts: { SKY: { kind: 'responds', properties: [supplierProperty('sky-padma')] } },
    })

    await run(world)
    world.results.age(resultCacheKey(criteria()), 240_000)

    const second = await run(world)

    expect(second.meta.source).toBe('cache')
    expect(second.meta.ageMs).toBe(240_000)
  })

  test('kriteria setara memakai entri cache yang sama', async () => {
    const world = searchHarness({
      scripts: { SKY: { kind: 'responds', properties: [supplierProperty('sky-padma')] } },
    })

    await run(world, { city: 'Bali' })
    await run(world, { city: '  bali ' })

    expect(world.suppliers.searched.get('SKY')).toBe(1)
  })

  test('kriteria berbeda memicu pencarian sendiri', async () => {
    const world = searchHarness({
      scripts: { SKY: { kind: 'responds', properties: [supplierProperty('sky-padma')] } },
    })

    await run(world, { guests: 2 })
    await run(world, { guests: 4 })

    expect(world.suppliers.searched.get('SKY')).toBe(2)
  })

  test('metrik kena dan luput dicatat per lapisan', async () => {
    const world = searchHarness({
      scripts: { SKY: { kind: 'responds', properties: [supplierProperty('sky-padma')] } },
    })

    await run(world)
    await run(world)

    expect(world.metrics.misses.results).toBe(1)
    expect(world.metrics.hits.results).toBe(1)
    expect(world.metrics.misses.supplier).toBe(1)
  })

  test('pembatalan per kota membuang hasil gabungannya', async () => {
    const world = searchHarness({
      scripts: { SKY: { kind: 'responds', properties: [supplierProperty('sky-padma')] } },
    })

    await run(world)
    const removed = await world.results.invalidateCity('search:city:bali')
    const after = await run(world)

    expect(removed).toBe(1)
    // Dihitung ulang, bukan dilayani dari cache.
    expect(after.meta.source).toBe('live')
    expect(world.pricing.calls.count).toBe(2)
  })

  test('pembatalan lapis pertama TIDAK membatalkan cache per supplier', async () => {
    // Disengaja. Pembatalan oleh operasi hampir selalu karena pandangan
    // GABUNGANNYA yang keliru — aturan markup berubah, katalog diperbaiki —
    // bukan karena jawaban supplier-nya salah. Ikut membuang lapis kedua
    // berarti memaksa lima supplier menjawab ulang untuk data yang masih
    // benar, tepat pada saat operator sedang memperbaiki sesuatu.
    const world = searchHarness({
      scripts: { SKY: { kind: 'responds', properties: [supplierProperty('sky-padma')] } },
    })

    await run(world)
    await world.results.invalidateCity('search:city:bali')
    await run(world)

    expect(world.suppliers.searched.get('SKY')).toBe(1)
  })

  test('cache yang gagal ditulis tidak menggagalkan pencarian', async () => {
    // Yang hilang hanya keuntungan pencarian berikutnya.
    const world = searchHarness({
      scripts: { SKY: { kind: 'responds', properties: [supplierProperty('sky-padma')] } },
    })
    world.results.failNextWrite()

    const response = await run(world)

    expect(response.properties).toHaveLength(1)
  })
})

describe('cache stampede', () => {
  test('seratus permintaan serentak hanya memicu satu fan-out', async () => {
    // Tanpa penguncian, seratus permintaan untuk kunci yang sama memicu lima
    // ratus panggilan supplier — justru pada saat trafik paling tinggi, yaitu
    // saat supplier paling tidak mampu menerimanya.
    const world = searchHarness({
      scripts: {
        SKY: { kind: 'responds', properties: [supplierProperty('sky-padma')] },
        NOVA: { kind: 'responds', properties: [supplierProperty('nova-padma')] },
      },
    })

    const responses = await Promise.all(Array.from({ length: 100 }, async () => await run(world)))

    expect(responses).toHaveLength(100)
    expect(world.suppliers.searched.get('SKY')).toBe(1)
    expect(world.suppliers.searched.get('NOVA')).toBe(1)
    expect(world.pricing.calls.count).toBe(1)
  })

  test('seratus permintaan itu semuanya mendapat hasil yang benar', async () => {
    // Menghitung panggilan saja dapat lulus dengan kode yang mengembalikan
    // hasil kosong untuk sembilan puluh sembilan di antaranya.
    const world = searchHarness({
      scripts: { SKY: { kind: 'responds', properties: [supplierProperty('sky-padma')] } },
    })

    const responses = await Promise.all(Array.from({ length: 100 }, async () => await run(world)))

    expect(responses.every((item) => item.properties.length === 1)).toBe(true)
  })

  test('kunci berbeda tidak saling menunggu', async () => {
    const world = searchHarness({
      scripts: { SKY: { kind: 'responds', properties: [supplierProperty('sky-padma')] } },
    })

    await Promise.all([run(world, { guests: 2 }), run(world, { guests: 4 })])

    expect(world.suppliers.searched.get('SKY')).toBe(2)
  })
})

describe('peristiwa', () => {
  test('search.performed terbit tanpa data pribadi', async () => {
    const world = searchHarness({
      scripts: { SKY: { kind: 'responds', properties: [supplierProperty('sky-padma')] } },
    })

    await run(world)
    const published = world.events.published[0]

    expect(published?.city).toBe('bali')
    expect(published?.resultCount).toBe(1)
    expect(Object.keys(published ?? {})).toEqual(
      expect.not.arrayContaining(['userId', 'email', 'ip', 'sessionId']),
    )
  })

  test('sumbernya ikut dilaporkan', async () => {
    const world = searchHarness({
      scripts: { SKY: { kind: 'responds', properties: [supplierProperty('sky-padma')] } },
    })

    await run(world)
    await run(world)

    expect(world.events.published.map((item) => item.source)).toEqual(['live', 'cache'])
  })

  test('supplier yang tidak berkontribusi ikut dilaporkan', async () => {
    const world = searchHarness({
      scripts: {
        SKY: { kind: 'responds', properties: [supplierProperty('sky-padma')] },
        ZEPH: { kind: 'fails' },
      },
    })

    await run(world)

    expect(world.events.published[0]?.suppliersUnavailable).toEqual(['ZEPH'])
  })
})

describe('penyaringan dan pengurutan', () => {
  test('penyaring harga bekerja pada harga JUAL', async () => {
    // Menyaring pada harga supplier akan membuang tawaran yang sebenarnya
    // masuk anggaran pengguna, dan menyisakan yang setelah markup melewatinya.
    // Rp 1.000.000 menjadi Rp 1.332.000 setelah markup dan pajak.
    const world = searchHarness({
      scripts: {
        SKY: { kind: 'responds', properties: [supplierProperty('sky-padma', 1_000_000)] },
      },
    })

    expect((await run(world, { maxTotalMinor: 1_400_000 })).properties).toHaveLength(1)

    world.results.entries.clear()
    expect((await run(world, { maxTotalMinor: 1_100_000 })).properties).toEqual([])
  })

  test('urutan harga memakai harga jual terendah', async () => {
    const world = searchHarness({
      scripts: {
        SKY: {
          kind: 'responds',
          properties: [
            supplierProperty('sky-padma', 1_500_000),
            supplierProperty('sky-wijaya', 900_000),
          ],
        },
      },
    })

    const response = await run(world, { sort: 'price' })

    expect(response.properties.map((item) => item.ref)).toEqual(['prop-wijaya', 'prop-padma'])
  })
})

describe('katalog belum termuat', () => {
  test('pencarian tetap menjawab, seluruhnya sebagai belum terpetakan', async () => {
    // Hasil yang buruk, tetapi jauh lebih baik daripada pencarian yang gagal
    // seluruhnya. Kesiapan service sudah bergantung pada katalog, jadi keadaan
    // ini seharusnya tidak pernah terjadi pada instance yang menerima trafik.
    const world = searchHarness({
      scripts: { SKY: { kind: 'responds', properties: [supplierProperty('sky-padma')] } },
      withoutCatalog: true,
    })

    const response = await run(world)

    expect(response.properties).toHaveLength(1)
    expect(response.properties[0]?.mapped).toBe(false)
  })
})
