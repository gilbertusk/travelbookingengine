import { describe, expect, test } from 'vitest'
import { createPropertyFromUnmapped, mapToExistingProperty } from './manual-mapping.js'
import { refreshCatalog } from './catalog-refresh.js'
import { buildMappingTable, resolveProperty } from '../domain/mapping.js'
import { harness, property, sourceOf } from '../testing/fakes.js'
import type { UnmappedProperty } from '../domain/property.js'

/**
 * Pemetaan manual oleh operator.
 *
 * Antrian properti belum terpetakan hanya berguna kalau ada cara
 * menyelesaikannya. Yang diuji di sini: kedua cara itu bekerja, dan keduanya
 * benar-benar mengubah hasil penyelesaian sesudahnya — bukan hanya menulis
 * baris yang tidak dibaca siapa pun.
 */

const PADMA = property({ id: 'prop-padma', slug: 'padma-bali-boutique-hotel' })

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

function world(unmapped: readonly UnmappedProperty[] = [pending()]) {
  return harness({ properties: [PADMA], mappings: [], unmapped })
}

describe('memetakan ke properti yang sudah ada', () => {
  test('pemetaan tersimpan dan ditandai pasti', async () => {
    const world_ = world()

    const result = await mapToExistingProperty(world_.deps, {
      supplierId: 'ZEPH',
      supplierPropertyId: 'zeph-999',
      propertyId: 'prop-padma',
      operator: 'operator-1',
    })

    expect(result.ok).toBe(true)
    expect(world_.mappings.rows[0]?.confidence).toBe(10_000)
    expect(world_.mappings.rows[0]?.mappedBy).toBe('operator-1')
  })

  test('properti berhenti muncul sebagai belum terpetakan sesudahnya', async () => {
    // Inilah yang membuktikan pemetaannya benar-benar berlaku, bukan sekadar
    // tersimpan. Baris yang tertulis tetapi tidak pernah terbaca adalah
    // pekerjaan operator yang terbuang.
    const world_ = world()

    await mapToExistingProperty(world_.deps, {
      supplierId: 'ZEPH',
      supplierPropertyId: 'zeph-999',
      propertyId: 'prop-padma',
      operator: 'operator-1',
    })
    await refreshCatalog(
      sourceOf({ properties: world_.properties.rows, mappings: world_.mappings.rows }),
      world_.deps.snapshots,
    )

    const snapshot = await world_.deps.snapshots.read()

    expect(snapshot?.propertyId('ZEPH', 'zeph-999')).toBe('prop-padma')
  })

  test('barisnya keluar dari antrian', async () => {
    const world_ = world()

    await mapToExistingProperty(world_.deps, {
      supplierId: 'ZEPH',
      supplierPropertyId: 'zeph-999',
      propertyId: 'prop-padma',
      operator: 'operator-1',
    })

    expect(await world_.deps.unmapped.pending(10)).toEqual([])
  })

  test('baris antrian yang tidak ada ditolak', async () => {
    const result = await mapToExistingProperty(world([]).deps, {
      supplierId: 'ZEPH',
      supplierPropertyId: 'zeph-999',
      propertyId: 'prop-padma',
      operator: 'operator-1',
    })

    expect(result).toEqual({ ok: false, reason: 'unmapped_not_found' })
  })

  test('properti tujuan yang tidak ada ditolak', async () => {
    const result = await mapToExistingProperty(world().deps, {
      supplierId: 'ZEPH',
      supplierPropertyId: 'zeph-999',
      propertyId: 'tidak-ada',
      operator: 'operator-1',
    })

    expect(result).toEqual({ ok: false, reason: 'property_not_found' })
  })

  test('penolakan tidak menulis apa pun', async () => {
    const world_ = world()

    await mapToExistingProperty(world_.deps, {
      supplierId: 'ZEPH',
      supplierPropertyId: 'zeph-999',
      propertyId: 'tidak-ada',
      operator: 'operator-1',
    })

    expect(world_.mappings.calls.writes).toBe(0)
    expect(world_.unmapped.rows.size).toBe(1)
  })
})

describe('membuat properti baru dari antrian', () => {
  const input = {
    supplierId: 'ZEPH' as const,
    supplierPropertyId: 'zeph-999',
    name: 'Kirana Lombok Resort',
    city: 'Lombok',
    countryCode: 'ID',
    timezone: 'Asia/Makassar',
    address: 'Jalan Anggrek No. 3',
    latitude: -8.65,
    longitude: 116.32,
    starRating: 4,
    operator: 'operator-1',
    newId: () => 'prop-baru',
    takenSlugs: new Set<string>(),
  }

  test('properti tersimpan beserta slug dan zona waktunya', async () => {
    const world_ = world()

    const result = await createPropertyFromUnmapped(world_.deps, input)

    expect(result).toEqual({ ok: true, propertyId: 'prop-baru', created: true })

    const created = world_.properties.rows.find((row) => row.id === 'prop-baru')
    expect(created?.slug).toBe('kirana-lombok-resort')
    expect(created?.timezone).toBe('Asia/Makassar')
  })

  test('nama yang dinormalkan ikut disimpan untuk pencocokan berikutnya', async () => {
    const world_ = world()

    await createPropertyFromUnmapped(world_.deps, input)

    expect(world_.properties.rows.find((row) => row.id === 'prop-baru')?.normalizedName).toBe(
      'kirana lombok resort',
    )
  })

  test('slug yang bertabrakan mendapat angka pembeda', async () => {
    const world_ = world()

    await createPropertyFromUnmapped(world_.deps, {
      ...input,
      takenSlugs: new Set(['kirana-lombok-resort']),
    })

    expect(world_.properties.rows.find((row) => row.id === 'prop-baru')?.slug).toBe(
      'kirana-lombok-resort-2',
    )
  })

  test('pemetaannya langsung menunjuk properti yang baru dibuat', async () => {
    const world_ = world()

    await createPropertyFromUnmapped(world_.deps, input)
    const table = buildMappingTable(world_.mappings.rows)

    expect(resolveProperty(table, 'ZEPH', 'zeph-999')).toEqual({
      kind: 'mapped',
      propertyId: 'prop-baru',
    })
  })

  test('properti baru tidak membawa harga maupun ketersediaan', async () => {
    const world_ = world()

    await createPropertyFromUnmapped(world_.deps, input)
    const keys = Object.keys(world_.properties.rows.find((row) => row.id === 'prop-baru') ?? {})

    for (const forbidden of ['price', 'rate', 'availability', 'currency']) {
      expect(keys.some((key) => key.toLowerCase().includes(forbidden))).toBe(false)
    }
  })

  test('baris antrian yang tidak ada ditolak tanpa membuat properti', async () => {
    const world_ = world([])

    const result = await createPropertyFromUnmapped(world_.deps, input)

    expect(result).toEqual({ ok: false, reason: 'unmapped_not_found' })
    expect(world_.properties.calls.writes).toBe(0)
  })
})
