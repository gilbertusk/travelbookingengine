import { describe, expect, test } from 'vitest'
import { suggest } from './autocomplete.js'
import { harness, property } from '../testing/fakes.js'

/**
 * Saran saat mengetik (FR-08).
 */

const CATALOG = [
  property({ id: 'p1', slug: 'padma-bali-boutique-hotel', name: 'Padma Bali Boutique Hotel' }),
  property({ id: 'p2', slug: 'padma-bali-resort', name: 'Padma Bali Resort' }),
  property({ id: 'p3', slug: 'wijaya-bali-grand-hotel', name: 'Wijaya Bali Grand Hotel' }),
  property({
    id: 'p4',
    slug: 'kirana-bandung-suites',
    name: 'Kirana Bandung Suites',
    city: 'Bandung',
  }),
  property({
    id: 'p5',
    slug: 'mahesa-bangkok-residence',
    name: 'Mahesa Bangkok Residence',
    city: 'Bangkok',
    countryCode: 'TH',
  }),
]

function world() {
  return harness({ properties: CATALOG })
}

describe('hasil yang relevan', () => {
  test('nama properti dicocokkan', async () => {
    const result = await suggest(world().deps, { query: 'padma' })

    expect(result.properties.map((item) => item.slug)).toEqual([
      'padma-bali-boutique-hotel',
      'padma-bali-resort',
    ])
  })

  test('kota dicocokkan dan dihitung propertinya', async () => {
    const result = await suggest(world().deps, { query: 'bali' })

    expect(result.cities[0]?.city).toBe('Bali')
    expect(result.cities[0]?.propertyCount).toBe(3)
  })

  test('kota membawa kode negaranya', async () => {
    const result = await suggest(world().deps, { query: 'bangkok' })

    expect(result.cities[0]).toEqual({ city: 'Bangkok', countryCode: 'TH', propertyCount: 1 })
  })

  test('kota diurutkan menurut banyaknya properti', async () => {
    const result = await suggest(world().deps, { query: 'ban' })

    // Bandung satu, Bangkok satu — pemutusnya abjad supaya hasilnya tetap.
    expect(result.cities.map((item) => item.city)).toEqual(['Bandung', 'Bangkok'])
  })

  test('saran properti membawa slug untuk URL-nya', async () => {
    const result = await suggest(world().deps, { query: 'wijaya' })

    expect(result.properties[0]?.slug).toBe('wijaya-bali-grand-hotel')
    expect(result.properties[0]?.name).toBe('Wijaya Bali Grand Hotel')
  })

  test('huruf besar-kecil tidak berpengaruh', async () => {
    const upper = await suggest(world().deps, { query: 'PADMA' })
    const lower = await suggest(world().deps, { query: 'padma' })

    expect(upper).toEqual(lower)
  })

  test('kueri yang tidak cocok menghasilkan hasil kosong, bukan galat', async () => {
    const result = await suggest(world().deps, { query: 'tidakadahotelini' })

    expect(result).toEqual({ cities: [], properties: [] })
  })
})

describe('kueri yang terlalu pendek', () => {
  test('satu huruf dijawab kosong tanpa menyentuh penyimpanan', async () => {
    // Satu huruf cocok dengan hampir seluruh katalog, jadi jawabannya tidak
    // membantu siapa pun sementara kuerinya paling mahal.
    const world_ = world()

    const result = await suggest(world_.deps, { query: 'p' })

    expect(result).toEqual({ cities: [], properties: [] })
    expect(world_.properties.calls.reads).toBe(0)
  })

  test('kueri kosong dijawab kosong, bukan ditolak', async () => {
    // Pengguna sedang mengetik, bukan salah.
    expect(await suggest(world().deps, { query: '   ' })).toEqual({ cities: [], properties: [] })
  })
})

describe('batas jumlah hasil', () => {
  test('batas bawaan diterapkan', async () => {
    const many = Array.from({ length: 40 }, (_, index) =>
      property({
        id: `p${String(index)}`,
        slug: `padma-${String(index)}`,
        name: `Padma ${String(index)}`,
      }),
    )

    const result = await suggest(harness({ properties: many }).deps, { query: 'padma' })

    expect(result.properties).toHaveLength(10)
  })

  test('batas yang diminta dihormati', async () => {
    const result = await suggest(world().deps, { query: 'bali', limit: 1 })

    expect(result.properties).toHaveLength(1)
  })

  test('batas yang tidak masuk akal dijepit, bukan diteruskan', async () => {
    const world_ = await suggest(world().deps, { query: 'bali', limit: 10_000 })

    expect(world_.properties.length).toBeLessThanOrEqual(25)
  })
})

describe('cache', () => {
  test('kueri yang sama hanya sekali menyentuh penyimpanan', async () => {
    // Kotak pencarian menghasilkan kueri yang sangat berulang: setiap pengguna
    // mengetik awalan kota yang sama.
    const world_ = world()

    await suggest(world_.deps, { query: 'padma' })
    await suggest(world_.deps, { query: 'padma' })
    await suggest(world_.deps, { query: 'padma' })

    expect(world_.properties.calls.reads).toBe(1)
    expect(world_.suggestions.calls.writes).toBe(1)
  })

  test('batas yang berbeda adalah kunci cache yang berbeda', async () => {
    // Kalau batasnya tidak ikut menjadi kunci, permintaan dengan limit 1 akan
    // mengembalikan hasil yang tersimpan untuk limit 10, atau sebaliknya.
    const world_ = world()

    await suggest(world_.deps, { query: 'bali', limit: 5 })
    await suggest(world_.deps, { query: 'bali', limit: 10 })

    expect(world_.properties.calls.reads).toBe(2)
  })

  test('hasil dari cache sama dengan hasil dari penyimpanan', async () => {
    const world_ = world()

    const first = await suggest(world_.deps, { query: 'padma' })
    const second = await suggest(world_.deps, { query: 'padma' })

    expect(second).toEqual(first)
  })
})
