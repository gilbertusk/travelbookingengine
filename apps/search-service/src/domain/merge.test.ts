import { describe, expect, test } from 'vitest'
import { money } from '@tbe/money'
import type { SupplierProperty, SupplierSearchResult } from '@tbe/supplier-adapters'
import { applyFilters, mergeResults, sortProperties, type MergedProperty } from './merge.js'
import { toSnapshot } from '../infrastructure/redis-catalog.js'
import { mapping, property } from '../testing/fakes.js'
import type { SearchCriteria } from './criteria.js'

/**
 * Penggabungan lintas supplier.
 *
 * Di sinilah FR-04 terjadi. Yang dijaga: satu hotel fisik yang dijual tiga
 * supplier menjadi satu entri, tawaran ketiganya tetap tersimpan, dan properti
 * belum terpetakan tidak hilang.
 */

const PADMA = property({ id: 'prop-padma', slug: 'padma-bali-boutique-hotel', starRating: 4 })
const WIJAYA = property({
  id: 'prop-wijaya',
  slug: 'wijaya-bali-grand-hotel',
  name: 'Wijaya Bali Grand Hotel',
  starRating: 3,
  amenities: ['wifi'],
})

const CATALOG = toSnapshot({
  properties: [PADMA, WIJAYA],
  mappings: [
    mapping({ supplierId: 'SKY', supplierPropertyId: 'sky-padma', propertyId: 'prop-padma' }),
    mapping({ supplierId: 'NOVA', supplierPropertyId: 'nova-padma', propertyId: 'prop-padma' }),
    mapping({ supplierId: 'LUNA', supplierPropertyId: 'luna-padma', propertyId: 'prop-padma' }),
    mapping({ supplierId: 'SKY', supplierPropertyId: 'sky-wijaya', propertyId: 'prop-wijaya' }),
  ],
})

interface RatePlanSpec {
  readonly id?: string
  readonly total?: number
  readonly refundable?: boolean
  readonly breakfast?: boolean
  readonly unitsLeft?: number
}

function supplierProperty(
  supplierPropertyId: string,
  plans: readonly RatePlanSpec[],
  overrides: Partial<SupplierProperty> = {},
): SupplierProperty {
  return {
    supplier: 'SKY',
    supplierPropertyId,
    name: 'Nama Versi Supplier',
    amenities: ['pool', 'wifi'],
    roomTypes: [
      {
        supplierRoomTypeId: `${supplierPropertyId}-rt`,
        name: 'Deluxe',
        ratePlans: plans.map((plan, index) => ({
          supplierRatePlanId: plan.id ?? `${supplierPropertyId}-rp-${String(index)}`,
          name: 'Refundable with Breakfast',
          total: money(plan.total ?? 1_000_000, 'IDR'),
          nightly: money(Math.round((plan.total ?? 1_000_000) / 2), 'IDR'),
          cancellationPolicy:
            (plan.refundable ?? true)
              ? { refundable: true, freeCancellationDays: 3 }
              : { refundable: false },
          breakfastIncluded: plan.breakfast ?? true,
          availability: { unitsLeft: plan.unitsLeft ?? 5 },
        })),
      },
    ],
    ...overrides,
  }
}

function result(
  supplier: SupplierSearchResult['supplier'],
  properties: readonly SupplierProperty[],
): SupplierSearchResult {
  return {
    supplier,
    checkIn: '2026-11-10',
    checkOut: '2026-11-12',
    properties: properties.map((item) => ({ ...item, supplier })),
  }
}

function criteria(overrides: Partial<SearchCriteria> = {}): SearchCriteria {
  return {
    city: 'bali',
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

const lowest = (item: MergedProperty) => item.offers[0]?.supplierTotal.amountMinor ?? 0

describe('satu hotel, banyak supplier', () => {
  test('tiga supplier menghasilkan satu entri', () => {
    const merged = mergeResults(
      [
        result('SKY', [supplierProperty('sky-padma', [{ total: 1_200_000 }])]),
        result('NOVA', [supplierProperty('nova-padma', [{ total: 1_100_000 }])]),
        result('LUNA', [supplierProperty('luna-padma', [{ total: 1_300_000 }])]),
      ],
      CATALOG,
    )

    expect(merged.properties).toHaveLength(1)
    expect(merged.properties[0]?.suppliers).toEqual(['SKY', 'NOVA', 'LUNA'])
  })

  test('seluruh tawaran tetap tersimpan untuk halaman detail', () => {
    // FR-10. Menyimpan hanya yang termurah berarti halaman detail tidak dapat
    // menampilkan perbandingan, dan perbandingan itu seluruh alasan produknya.
    const merged = mergeResults(
      [
        result('SKY', [
          supplierProperty('sky-padma', [{ total: 1_200_000 }, { total: 1_500_000 }]),
        ]),
        result('NOVA', [supplierProperty('nova-padma', [{ total: 1_100_000 }])]),
      ],
      CATALOG,
    )

    expect(merged.properties[0]?.offers).toHaveLength(3)
  })

  test('tawaran terurut dari termurah', () => {
    const merged = mergeResults(
      [
        result('SKY', [supplierProperty('sky-padma', [{ total: 1_500_000 }])]),
        result('NOVA', [supplierProperty('nova-padma', [{ total: 1_100_000 }])]),
        result('LUNA', [supplierProperty('luna-padma', [{ total: 1_300_000 }])]),
      ],
      CATALOG,
    )

    expect(merged.properties[0]?.offers.map((offer) => offer.supplierTotal.amountMinor)).toEqual([
      1_100_000, 1_300_000, 1_500_000,
    ])
  })

  test('harga sama diputus supplier lalu pengenal, supaya urutannya tetap', () => {
    const merged = mergeResults(
      [
        result('NOVA', [supplierProperty('nova-padma', [{ id: 'b', total: 1_000_000 }])]),
        result('SKY', [supplierProperty('sky-padma', [{ id: 'a', total: 1_000_000 }])]),
      ],
      CATALOG,
    )

    expect(merged.properties[0]?.offers.map((offer) => offer.supplier)).toEqual(['NOVA', 'SKY'])
  })

  test('nama diambil dari katalog, bukan dari supplier yang menjawab lebih dulu', () => {
    // Supplier menyebut hotel yang sama dengan ejaan berbeda-beda. Memakai
    // ejaan supplier membuat nama hotel berubah-ubah antar pencarian.
    const merged = mergeResults(
      [
        result('NOVA', [
          supplierProperty('nova-padma', [{}], { name: 'PADMA BALI BOUTIQUE HOTEL' }),
        ]),
      ],
      CATALOG,
    )

    expect(merged.properties[0]?.name).toBe('Padma Bali Boutique Hotel')
  })

  test('properti terpetakan membawa slug permanennya', () => {
    const merged = mergeResults([result('SKY', [supplierProperty('sky-padma', [{}])])], CATALOG)

    expect(merged.properties[0]?.slug).toBe('padma-bali-boutique-hotel')
    expect(merged.properties[0]?.mapped).toBe(true)
  })

  test('properti berbeda tetap terpisah', () => {
    const merged = mergeResults(
      [result('SKY', [supplierProperty('sky-padma', [{}]), supplierProperty('sky-wijaya', [{}])])],
      CATALOG,
    )

    expect(merged.properties).toHaveLength(2)
  })
})

describe('properti belum terpetakan', () => {
  test('tetap muncul, tidak disembunyikan', () => {
    const merged = mergeResults(
      [result('ZEPH', [supplierProperty('zeph-baru', [{}], { name: 'Kirana Bali Htl.' })])],
      CATALOG,
    )

    expect(merged.properties).toHaveLength(1)
    expect(merged.properties[0]?.mapped).toBe(false)
    expect(merged.properties[0]?.name).toBe('Kirana Bali Htl.')
  })

  test('tidak punya slug', () => {
    const merged = mergeResults([result('ZEPH', [supplierProperty('zeph-baru', [{}])])], CATALOG)

    expect(merged.properties[0]?.slug).toBeUndefined()
  })

  test('pengenalnya jelas-jelas bukan slug', () => {
    // Pengenal ini berubah begitu pemetaannya ada. Bentuk yang jelas-jelas
    // bukan slug membuat kesalahan memakainya sebagai URL terlihat saat
    // ditulis, bukan berbulan-bulan kemudian.
    const merged = mergeResults([result('ZEPH', [supplierProperty('zeph-baru', [{}])])], CATALOG)

    expect(merged.properties[0]?.ref).toBe('unmapped:ZEPH:zeph-baru')
  })

  test('dicatat untuk antrian pemetaan', () => {
    const merged = mergeResults(
      [result('ZEPH', [supplierProperty('zeph-baru', [{}], { name: 'Kirana Bali Htl.' })])],
      CATALOG,
    )

    expect(merged.unmapped).toHaveLength(1)
    expect(merged.unmapped[0]).toMatchObject({ supplierId: 'ZEPH', name: 'Kirana Bali Htl.' })
  })

  test('yang terpetakan tidak ikut dicatat sebagai belum terpetakan', () => {
    const merged = mergeResults([result('SKY', [supplierProperty('sky-padma', [{}])])], CATALOG)

    expect(merged.unmapped).toEqual([])
  })

  test('dua supplier berbeda yang sama-sama belum terpetakan tidak digabung', () => {
    // Tanpa pemetaan tidak ada dasar untuk menyatakan keduanya hotel yang
    // sama. Menggabungkannya lewat kemiripan nama adalah persis yang ditolak
    // pada ADR-0001.
    const merged = mergeResults(
      [
        result('ZEPH', [supplierProperty('zeph-x', [{}], { name: 'Kirana Bali Hotel' })]),
        result('LUNA', [supplierProperty('luna-x', [{}], { name: 'Hotel Kirana Bali' })]),
      ],
      CATALOG,
    )

    expect(merged.properties).toHaveLength(2)
  })
})

describe('ketersediaan', () => {
  test('rate plan tanpa unit tersisa bukan tawaran', () => {
    // Menampilkannya berarti menjanjikan kamar yang tidak ada.
    const merged = mergeResults(
      [result('SKY', [supplierProperty('sky-padma', [{ unitsLeft: 0 }, { unitsLeft: 2 }])])],
      CATALOG,
    )

    expect(merged.properties[0]?.offers).toHaveLength(1)
  })

  test('properti yang seluruh tawarannya habis tidak muncul', () => {
    const merged = mergeResults(
      [result('SKY', [supplierProperty('sky-padma', [{ unitsLeft: 0 }])])],
      CATALOG,
    )

    expect(merged.properties).toEqual([])
  })

  test('properti yang habis juga tidak masuk antrian pemetaan', () => {
    // Antrian operator diisi dari properti yang benar-benar dapat dijual.
    const merged = mergeResults(
      [result('ZEPH', [supplierProperty('zeph-baru', [{ unitsLeft: 0 }])])],
      CATALOG,
    )

    expect(merged.unmapped).toEqual([])
  })
})

describe('penyaringan', () => {
  const merged = mergeResults(
    [
      result('SKY', [
        supplierProperty('sky-padma', [
          { id: 'a', refundable: true, breakfast: true, total: 1_000_000 },
          { id: 'b', refundable: false, breakfast: false, total: 800_000 },
        ]),
        supplierProperty('sky-wijaya', [{ id: 'c', refundable: false, breakfast: false }]),
      ]),
    ],
    CATALOG,
  ).properties

  test('bintang minimum menyaring propertinya', () => {
    const filtered = applyFilters(merged, criteria({ minStarRating: 4 }))

    expect(filtered.map((item) => item.ref)).toEqual(['prop-padma'])
  })

  test('fasilitas dicocokkan terhadap katalog', () => {
    // Wijaya hanya punya wifi; Padma punya pool dan wifi.
    expect(applyFilters(merged, criteria({ amenities: ['pool'] })).map((item) => item.ref)).toEqual(
      ['prop-padma'],
    )
  })

  test('hanya refundable menyaring TAWARAN, bukan langsung propertinya', () => {
    // Properti yang satu tarifnya refundable dan satu lagi tidak harus tetap
    // muncul — yang disaring tawarannya.
    const filtered = applyFilters(merged, criteria({ refundableOnly: true }))

    expect(filtered.map((item) => item.ref)).toEqual(['prop-padma'])
    expect(filtered[0]?.offers.map((offer) => offer.supplierRatePlanId)).toEqual(['a'])
  })

  test('properti yang seluruh tawarannya tersaring ikut hilang', () => {
    const filtered = applyFilters(merged, criteria({ breakfastIncluded: true }))

    expect(filtered.map((item) => item.ref)).toEqual(['prop-padma'])
  })

  test('daftar supplier ikut menyusut bersama tawarannya', () => {
    // Metadata yang menyebut supplier yang seluruh tawarannya tersaring
    // adalah metadata yang berbohong.
    const dua = mergeResults(
      [
        result('SKY', [supplierProperty('sky-padma', [{ refundable: true }])]),
        result('NOVA', [supplierProperty('nova-padma', [{ refundable: false }])]),
      ],
      CATALOG,
    ).properties

    const filtered = applyFilters(dua, criteria({ refundableOnly: true }))

    expect(filtered[0]?.suppliers).toEqual(['SKY'])
  })

  test('tanpa penyaring, semuanya lolos', () => {
    expect(applyFilters(merged, criteria())).toHaveLength(2)
  })
})

describe('pengurutan', () => {
  const merged = mergeResults(
    [
      result('SKY', [
        supplierProperty('sky-padma', [{ total: 1_500_000 }]),
        supplierProperty('sky-wijaya', [{ total: 900_000 }]),
      ]),
      result('ZEPH', [supplierProperty('zeph-baru', [{ total: 500_000 }])]),
    ],
    CATALOG,
  ).properties

  test('harga: termurah lebih dulu', () => {
    expect(sortProperties(merged, criteria({ sort: 'price' }), lowest).map(lowest)).toEqual([
      500_000, 900_000, 1_500_000,
    ])
  })

  test('peringkat: bintang tertinggi lebih dulu', () => {
    const sorted = sortProperties(merged, criteria({ sort: 'rating' }), lowest)

    expect(sorted.map((item) => item.starRating ?? 0)).toEqual([4, 3, 0])
  })

  test('relevansi: properti terpetakan didahulukan', () => {
    // Keputusan produk, bukan teknis: properti terpetakan punya nama kanonik
    // dan halaman yang dapat dibuka; yang belum hanya punya kata supplier.
    const sorted = sortProperties(merged, criteria({ sort: 'relevance' }), lowest)

    expect(sorted.map((item) => item.mapped)).toEqual([true, true, false])
  })

  test('daftar asal tidak diubah', () => {
    const before = merged.map((item) => item.ref)

    sortProperties(merged, criteria({ sort: 'price' }), lowest)

    expect(merged.map((item) => item.ref)).toEqual(before)
  })
})

describe('daftar kosong', () => {
  test('tanpa hasil supplier, hasilnya kosong dan bukan galat', () => {
    expect(mergeResults([], CATALOG)).toEqual({ properties: [], unmapped: [] })
  })

  test('supplier yang menjawab tanpa properti tidak menambah apa pun', () => {
    expect(mergeResults([result('SKY', [])], CATALOG).properties).toEqual([])
  })
})
