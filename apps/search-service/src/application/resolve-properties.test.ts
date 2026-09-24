import { describe, expect, test } from 'vitest'
import { createSightingBuffer, resolveProperties } from './resolve-properties.js'
import { flushSightings } from './catalog-refresh.js'
import { harness, mapping, property, snapshotOf } from '../testing/fakes.js'
import type { RawSupplierProperty } from '../domain/property.js'

/**
 * Penyelesaian properti pada jalur pencarian.
 *
 * Dua hal yang dijaga di sini: bahwa pengenal supplier yang berbeda menyatu
 * ke satu properti internal, dan bahwa jalur ini TIDAK MENYENTUH BASIS DATA.
 * Yang kedua dibuktikan dengan menghitung, bukan mengukur waktu.
 */

const PADMA = property({ id: 'prop-padma', slug: 'padma-bali-boutique-hotel' })
const WIJAYA = property({
  id: 'prop-wijaya',
  slug: 'wijaya-bali-grand-hotel',
  name: 'Wijaya Bali Grand Hotel',
})

const MAPPINGS = [
  mapping({ supplierId: 'SKY', supplierPropertyId: 'sky-120', propertyId: 'prop-padma' }),
  mapping({ supplierId: 'NOVA', supplierPropertyId: 'nova-345', propertyId: 'prop-padma' }),
  mapping({ supplierId: 'LUNA', supplierPropertyId: 'luna-338', propertyId: 'prop-padma' }),
  mapping({ supplierId: 'ORBIT', supplierPropertyId: 'orbit-135', propertyId: 'prop-wijaya' }),
]

function world() {
  return harness({ properties: [PADMA, WIJAYA], mappings: MAPPINGS })
}

function raw(overrides: Partial<RawSupplierProperty> = {}): RawSupplierProperty {
  return {
    supplierId: 'SKY',
    supplierPropertyId: 'sky-120',
    name: 'Padma Bali Boutique Hotel',
    city: 'Bali',
    ...overrides,
  }
}

const SNAPSHOT = snapshotOf({ properties: [PADMA, WIJAYA], mappings: MAPPINGS })

describe('satu hotel, banyak supplier', () => {
  test('tiga pengenal supplier menghasilkan satu entri', () => {
    // FR-04. Tanpa ini, hasil pencarian menampilkan hotel yang sama tiga kali
    // dan pengguna tidak dapat membandingkan harganya — padahal membandingkan
    // harga adalah seluruh alasan produk ini ada.
    const result = resolveProperties(
      SNAPSHOT,
      [
        raw({ supplierId: 'SKY', supplierPropertyId: 'sky-120' }),
        raw({ supplierId: 'NOVA', supplierPropertyId: 'nova-345' }),
        raw({ supplierId: 'LUNA', supplierPropertyId: 'luna-338' }),
      ],
      createSightingBuffer(),
    )

    expect(result.properties).toHaveLength(1)
    expect(result.properties[0]?.kind).toBe('mapped')
    expect(result.bySupplier.get('prop-padma')).toEqual(['SKY', 'NOVA', 'LUNA'])
  })

  test('properti berbeda tetap terpisah', () => {
    const result = resolveProperties(
      SNAPSHOT,
      [raw(), raw({ supplierId: 'ORBIT', supplierPropertyId: 'orbit-135' })],
      createSightingBuffer(),
    )

    expect(result.properties).toHaveLength(2)
  })

  test('properti yang terpetakan membawa slug permanennya', () => {
    const result = resolveProperties(SNAPSHOT, [raw()], createSightingBuffer())
    const first = result.properties[0]

    if (first?.kind !== 'mapped') throw new Error('seharusnya terpetakan')
    expect(first.property.slug).toBe('padma-bali-boutique-hotel')
  })
})

describe('properti belum terpetakan', () => {
  test('tetap muncul di hasil, tidak disembunyikan', () => {
    // Menyembunyikannya berarti kehilangan inventaris. Agregator yang membuang
    // inventaris demi kerapian basis data sedang merugikan dirinya sendiri.
    const result = resolveProperties(
      SNAPSHOT,
      [raw({ supplierId: 'ZEPH', supplierPropertyId: 'zeph-999', name: 'Kirana Bali Htl.' })],
      createSightingBuffer(),
    )

    expect(result.properties).toHaveLength(1)
    expect(result.properties[0]?.kind).toBe('unmapped')
  })

  test('ditampilkan dengan data mentah supplier', () => {
    const result = resolveProperties(
      SNAPSHOT,
      [
        raw({
          supplierId: 'ZEPH',
          supplierPropertyId: 'zeph-999',
          name: 'Kirana Bali Htl.',
          address: 'Jalan Anggrek No. 3',
        }),
      ],
      createSightingBuffer(),
    )

    const first = result.properties[0]
    if (first?.kind !== 'unmapped') throw new Error('seharusnya belum terpetakan')
    expect(first.name).toBe('Kirana Bali Htl.')
    expect(first.address).toBe('Jalan Anggrek No. 3')
  })

  test('tidak punya slug', () => {
    // Tanpa pemetaan tidak ada identitas internal, dan tanpa identitas internal
    // tidak ada URL yang stabil untuk diindeks. Tipenya yang menjaga ini:
    // varian `unmapped` tidak punya bidang slug sama sekali.
    const result = resolveProperties(
      SNAPSHOT,
      [raw({ supplierId: 'ZEPH', supplierPropertyId: 'zeph-999' })],
      createSightingBuffer(),
    )

    expect(Object.keys(result.properties[0] ?? {})).not.toContain('slug')
  })

  test('yang terpetakan dan yang belum muncul berdampingan', () => {
    const result = resolveProperties(
      SNAPSHOT,
      [raw(), raw({ supplierId: 'ZEPH', supplierPropertyId: 'zeph-999' })],
      createSightingBuffer(),
    )

    expect(result.properties.map((item) => item.kind)).toEqual(['mapped', 'unmapped'])
  })

  test('pemetaan yang menunjuk properti yang hilang diperlakukan belum terpetakan', () => {
    // Snapshot yang tidak konsisten tidak boleh membuat inventaris lenyap
    // tanpa jejak.
    const broken = snapshotOf({
      properties: [],
      mappings: [mapping({ supplierId: 'SKY', supplierPropertyId: 'sky-120' })],
    })

    const result = resolveProperties(broken, [raw()], createSightingBuffer())

    expect(result.properties[0]?.kind).toBe('unmapped')
  })
})

describe('penghitung kemunculan', () => {
  test('kemunculan berulang digabung sebelum ditulis', () => {
    // Satu pencarian dapat memunculkan properti yang sama dari lima supplier.
    // Lima penulisan untuk satu kenyataan adalah empat yang sia-sia.
    const buffer = createSightingBuffer()

    for (let index = 0; index < 5; index += 1) {
      resolveProperties(
        SNAPSHOT,
        [raw({ supplierId: 'ZEPH', supplierPropertyId: 'zeph-999' })],
        buffer,
      )
    }

    const drained = buffer.drain()

    expect(drained).toHaveLength(1)
    expect(drained[0]?.occurrences).toBe(5)
  })

  test('ditulis ke antrian saat disiram, bukan saat pencarian', async () => {
    const world_ = world()
    const buffer = createSightingBuffer()

    resolveProperties(
      SNAPSHOT,
      [raw({ supplierId: 'ZEPH', supplierPropertyId: 'zeph-999' })],
      buffer,
    )

    expect(world_.unmapped.calls.writes).toBe(0)

    await flushSightings(buffer, world_.deps.unmapped, () => undefined)

    expect(world_.unmapped.calls.writes).toBe(1)
    expect(world_.unmapped.rows.get('ZEPH:zeph-999')?.occurrences).toBe(1)
  })

  test('penghitung bertambah pada penyiraman berikutnya', async () => {
    const world_ = world()
    const buffer = createSightingBuffer()
    const item = raw({ supplierId: 'ZEPH', supplierPropertyId: 'zeph-999' })

    resolveProperties(SNAPSHOT, [item, item], buffer)
    await flushSightings(buffer, world_.deps.unmapped, () => undefined)

    resolveProperties(SNAPSHOT, [item], buffer)
    await flushSightings(buffer, world_.deps.unmapped, () => undefined)

    expect(world_.unmapped.rows.get('ZEPH:zeph-999')?.occurrences).toBe(3)
  })

  test('penyiraman tanpa isi tidak menulis apa pun', async () => {
    const world_ = world()

    expect(
      await flushSightings(createSightingBuffer(), world_.deps.unmapped, () => undefined),
    ).toBe(0)
    expect(world_.unmapped.calls.writes).toBe(0)
  })

  test('kegagalan penulisan dilaporkan dan tidak menumpuk di penyangga', async () => {
    // Penyangga yang tumbuh karena basis data tumbang akan menghabiskan memori
    // proses. Penghitung yang meleset jauh lebih murah daripada service mati.
    const world_ = world()
    const buffer = createSightingBuffer()
    const errors: unknown[] = []

    resolveProperties(SNAPSHOT, [raw({ supplierId: 'ZEPH', supplierPropertyId: 'z-1' })], buffer)
    world_.unmapped.failNextWrite()

    expect(await flushSightings(buffer, world_.deps.unmapped, (e) => errors.push(e))).toBe(0)
    expect(errors).toHaveLength(1)
    expect(buffer.size).toBe(0)
  })

  test('penyangga berhenti tumbuh pada batasnya', () => {
    // Supplier yang tiba-tiba mengembalikan ribuan properti baru tidak boleh
    // menumbuhkan penyangga tanpa henti.
    const buffer = createSightingBuffer(3)

    for (let index = 0; index < 50; index += 1) {
      buffer.add(raw({ supplierId: 'ZEPH', supplierPropertyId: `z-${String(index)}` }))
    }

    expect(buffer.size).toBe(3)
  })
})

describe('jalur pencarian tidak menyentuh basis data', () => {
  test('menyelesaikan 500 properti tanpa satu pun pembacaan basis data', () => {
    // Inilah syaratnya, dan dibuktikan dengan MENGHITUNG — mengukur waktu akan
    // lulus pada mesin cepat meski setiap pemetaan menembak Postgres.
    const world_ = world()
    const buffer = createSightingBuffer()

    const items = Array.from({ length: 500 }, (_, index) =>
      index % 2 === 0
        ? raw()
        : raw({ supplierId: 'ZEPH', supplierPropertyId: `zeph-${String(index)}` }),
    )

    const result = resolveProperties(SNAPSHOT, items, buffer)

    expect(result.properties.length).toBeGreaterThan(0)
    expect(world_.properties.calls.reads).toBe(0)
    expect(world_.mappings.calls.reads).toBe(0)
    expect(world_.unmapped.calls.reads).toBe(0)
    expect(world_.unmapped.calls.writes).toBe(0)
  })

  test('seluruh hasil benar, bukan hanya jumlah pembacaannya', () => {
    // Menghitung pembacaan saja dapat lulus dengan kode yang mengembalikan
    // hasil kosong.
    const buffer = createSightingBuffer()
    const items = Array.from({ length: 250 }, (_, index) =>
      raw({ supplierId: 'ZEPH', supplierPropertyId: `zeph-${String(index)}` }),
    )

    const result = resolveProperties(SNAPSHOT, items, buffer)

    expect(result.properties).toHaveLength(250)
    expect(buffer.size).toBe(250)
  })

  test('daftar kosong menghasilkan hasil kosong, bukan galat', () => {
    const result = resolveProperties(SNAPSHOT, [], createSightingBuffer())

    expect(result.properties).toEqual([])
    expect(result.bySupplier.size).toBe(0)
  })
})
