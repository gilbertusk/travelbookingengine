import { Router } from 'express'
import type { CatalogReader } from '../application/ports.js'
import {
  SUPPLIER_CODES,
  coversProperty,
  supplierPropertyName,
  supplierPropertyRef,
} from '../domain/supplier.js'

/**
 * Kebenaran dasar katalog, untuk keperluan seed.
 *
 * Endpoint ini menerbitkan sesuatu yang tidak pernah diterbitkan supplier
 * sungguhan: properti kanonik beserta daftar supplier yang menjualnya dan
 * pengenal versi masing-masing. Supplier sungguhan tidak tahu apa-apa tentang
 * supplier lain, dan justru ketidaktahuan itulah yang membuat pemetaan di
 * Step 12b perlu ada.
 *
 * Alasan endpoint ini tetap dibuat: seed katalog harus membangun pemetaan
 * dari data seed, BUKAN dari tebakan. Mencocokkan nama pada tahap seed akan
 * membekukan kesalahan pencocokan ke dalam basis data sebagai kebenaran, dan
 * seluruh pengujian sesudahnya akan mengukur kesalahan itu alih-alih
 * menemukannya.
 *
 * Batas yang berlaku ketat: tidak satu pun kode yang berjalan pada jalur
 * pencarian boleh memanggilnya. Ia berada di bawah `/admin` supaya batas itu
 * terlihat dari URL-nya, dan di produksi tidak ada padanannya — pemetaan
 * sungguhan dibangun operator lewat antrian properti belum terpetakan.
 */

export function createCatalogRouter(catalog: CatalogReader): Router {
  const router = Router()

  router.get('/catalog', (_req, res) => {
    const properties = catalog.allProperties().map((property) => ({
      id: property.id,
      name: property.name,
      city: property.city,
      countryCode: property.countryCode,
      address: property.address,
      latitude: property.latitude,
      longitude: property.longitude,
      timezone: property.timezone,
      starRating: property.starRating,
      amenities: property.amenities,
      // Supplier mana saja yang menjual properti ini, dan dengan pengenal
      // serta ejaan nama seperti apa. Inilah bagian yang tidak dapat
      // disimpulkan dari memanggil supplier satu per satu.
      offeredBy: SUPPLIER_CODES.filter((code) => coversProperty(code, property.id)).map((code) => ({
        supplier: code,
        supplierPropertyId: supplierPropertyRef(code, property.id),
        supplierName: supplierPropertyName(code, property.name),
      })),
    }))

    res.json({ data: { properties }, error: null })
  })

  return router
}
