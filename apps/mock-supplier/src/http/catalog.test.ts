import request from 'supertest'
import { describe, expect, test } from 'vitest'
import { createHarness } from '../testing/harness.js'
import { PROPERTIES_PER_CITY, CITIES } from '../domain/catalog.js'
import { SUPPLIER_CODES } from '../domain/supplier.js'

/**
 * Kebenaran dasar katalog.
 *
 * Yang dijaga di sini bukan bentuk JSON-nya, melainkan sifat yang membuat
 * seed di Step 12b dapat dipercaya: bahwa satu properti fisik benar-benar
 * muncul di beberapa supplier dengan pengenal dan ejaan nama yang berbeda,
 * dan bahwa jawabannya sama setiap kali ditanya.
 */

interface CatalogOffer {
  supplier: string
  supplierPropertyId: string
  supplierName: string
}

interface CatalogEntry {
  id: string
  name: string
  city: string
  timezone: string
  countryCode: string
  phone: string
  email: string
  offeredBy: CatalogOffer[]
}

async function fetchCatalog(): Promise<CatalogEntry[]> {
  const harness = createHarness()
  const response = await request(harness.app).get('/admin/catalog')

  expect(response.status).toBe(200)
  return response.body.data.properties as CatalogEntry[]
}

describe('katalog kanonik', () => {
  test('memuat seluruh properti dari seluruh kota', async () => {
    const properties = await fetchCatalog()

    expect(properties).toHaveLength(CITIES.length * PROPERTIES_PER_CITY)
  })

  test('setiap properti membawa zona waktunya', async () => {
    // Step 25 menghitung tenggat pembatalan dengan zona waktu properti.
    // Kolom yang kosong di sini menjadi migrasi data berbulan-bulan kemudian.
    const properties = await fetchCatalog()

    expect(properties.every((property) => property.timezone.length > 0)).toBe(true)
  })

  test('setiap properti membawa kontak untuk e-voucher, dengan kode negaranya', async () => {
    // Step 23: voucher wajib memuat kontak properti.
    const properties = await fetchCatalog()
    const dial: Record<string, string> = { ID: '+62', SG: '+65', MY: '+60', TH: '+66' }

    for (const property of properties) {
      expect(property.phone.startsWith(`${dial[property.countryCode] ?? '?'} `)).toBe(true)
      expect(property.email).toMatch(/^reservasi@[a-z0-9-]+.example$/)
    }
  })

  test('jawabannya sama setiap kali ditanya', async () => {
    // Seed yang dijalankan dua kali harus menghasilkan katalog yang sama.
    // Kalau sumbernya sendiri bergeser, idempotensi seed tidak berarti apa-apa.
    expect(await fetchCatalog()).toEqual(await fetchCatalog())
  })
})

describe('properti yang sama di beberapa supplier', () => {
  test('ada properti yang dijual lebih dari satu supplier', async () => {
    // Inilah yang membuat deduplikasi punya sesuatu untuk dikerjakan.
    const properties = await fetchCatalog()
    const shared = properties.filter((property) => property.offeredBy.length > 1)

    expect(shared.length).toBeGreaterThan(properties.length / 2)
  })

  test('pengenal versi supplier berbeda-beda untuk properti yang sama', async () => {
    // Kalau pengenalnya seragam, tabel pemetaan tidak dibutuhkan — cukup
    // memotong awalan string. Perbedaan ini yang membuatnya dibutuhkan.
    const properties = await fetchCatalog()
    const shared = properties.find((property) => property.offeredBy.length > 2)
    if (shared === undefined) throw new Error('tidak ada properti yang dijual tiga supplier')

    const refs = new Set(shared.offeredBy.map((offer) => offer.supplierPropertyId))

    expect(refs.size).toBe(shared.offeredBy.length)
  })

  test('tidak satu pun pengenal supplier menyerupai pengenal internal', async () => {
    const properties = await fetchCatalog()

    for (const property of properties) {
      for (const offer of property.offeredBy) {
        expect(offer.supplierPropertyId).not.toContain(property.id)
      }
    }
  })

  test('ejaan nama berbeda antar supplier untuk properti yang sama', async () => {
    // Variasi inilah yang membuat pencocokan berbasis nama rapuh: kapital
    // semua, awalan "Hotel", singkatan "Htl.".
    const properties = await fetchCatalog()
    const shared = properties.find((property) =>
      ['NOVA', 'LUNA'].every((code) => property.offeredBy.some((offer) => offer.supplier === code)),
    )
    if (shared === undefined) throw new Error('tidak ada properti yang dijual NOVA dan LUNA')

    const nova = shared.offeredBy.find((offer) => offer.supplier === 'NOVA')?.supplierName
    const luna = shared.offeredBy.find((offer) => offer.supplier === 'LUNA')?.supplierName

    expect(nova).toBe(shared.name.toUpperCase())
    expect(luna).toBe(`Hotel ${shared.name}`)
  })

  test('hanya supplier yang dikenal yang muncul', async () => {
    const properties = await fetchCatalog()
    const suppliers = new Set(
      properties.flatMap((property) => property.offeredBy.map((offer) => offer.supplier)),
    )

    for (const supplier of suppliers) {
      expect(SUPPLIER_CODES).toContain(supplier)
    }
  })
})
