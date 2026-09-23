import type { ChaosRegistry } from '../application/chaos.js'
import type { CatalogReader, OperationDeps, RefIndex } from '../application/ports.js'
import { IDR_PER_USD, type SupplierCurrency } from '../domain/supplier.js'

export interface SupplierContext {
  readonly deps: OperationDeps
  readonly chaos: ChaosRegistry
  readonly refs: RefIndex
  readonly catalog: CatalogReader
}

/**
 * Konversi ke mata uang supplier.
 *
 * Supplier yang menjual dalam USD menyebut harga dalam satuan utama dengan dua
 * desimal, bukan satuan terkecil. Perbedaan ini disengaja: adapter pada Step 10
 * harus menangani dua konvensi yang berbeda, dan yang lebih penting, Step 12
 * harus mengonversinya kembali tanpa kehilangan satuan terkecil.
 */
export function toSupplierAmount(
  minorIdr: number,
  currency: SupplierCurrency,
): { readonly minor: number; readonly decimal: string } {
  if (currency === 'IDR') {
    return { minor: minorIdr, decimal: String(minorIdr) }
  }

  const usdMinor = Math.round(minorIdr / (IDR_PER_USD / 100))
  return { minor: usdMinor, decimal: (usdMinor / 100).toFixed(2) }
}

export function isoDate(epochMs: number): string {
  return new Date(epochMs).toISOString()
}

/**
 * Parameter path sebagai string.
 *
 * Tipe req.params pada Express 5 memuat kemungkinan array dan undefined,
 * yang tidak pernah terjadi untuk parameter tunggal tetapi tetap harus
 * dipersempit agar tidak ada nilai longgar merembet ke lapisan aplikasi.
 */
export function pathParam(req: { params: Record<string, unknown> }, name: string): string {
  const value = req.params[name]
  return typeof value === 'string' ? value : ''
}
