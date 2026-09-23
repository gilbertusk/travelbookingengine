import type { RefIndex } from '../application/ports.js'
import type { Catalog } from '../domain/catalog.js'
import { SUPPLIER_CODES, supplierPropertyRef, supplierRateRef } from '../domain/supplier.js'

/**
 * Implementasi port RefIndex.
 *
 * Supplier hanya pernah menyebut pengenalnya sendiri, dan permintaan berikutnya
 * datang membawa pengenal itu. Tanpa index ini, setiap permintaan harus memindai
 * seluruh katalog untuk menemukan asalnya.
 */

export function createRefIndex(catalog: Catalog): RefIndex {
  const rateRefs = new Map<string, string>()
  const propertyRefs = new Map<string, string>()
  const rateReverse = new Map<string, string>()
  const propertyReverse = new Map<string, string>()

  for (const supplier of SUPPLIER_CODES) {
    for (const ratePlan of catalog.ratePlans) {
      const ref = supplierRateRef(supplier, ratePlan.id)
      rateRefs.set(`${supplier}#${ratePlan.id}`, ref)
      rateReverse.set(`${supplier}#${ref}`, ratePlan.id)
    }

    for (const property of catalog.properties) {
      const ref = supplierPropertyRef(supplier, property.id)
      propertyRefs.set(`${supplier}#${property.id}`, ref)
      propertyReverse.set(`${supplier}#${ref}`, property.id)
    }
  }

  return {
    rateRef: (supplier, ratePlanId) =>
      rateRefs.get(`${supplier}#${ratePlanId}`) ?? supplierRateRef(supplier, ratePlanId),
    propertyRef: (supplier, propertyId) =>
      propertyRefs.get(`${supplier}#${propertyId}`) ?? supplierPropertyRef(supplier, propertyId),
    ratePlanIdOf: (supplier, ref) => rateReverse.get(`${supplier}#${ref}`),
    propertyIdOf: (supplier, ref) => propertyReverse.get(`${supplier}#${ref}`),
  }
}
