import type { TaxPolicy } from '../domain/pricing.js'
import type { TaxPolicyProvider } from '../application/ports.js'

/**
 * Kebijakan pajak.
 *
 * Satu tarif untuk seluruh kota pada MVP — seluruh inventaris berada di
 * Indonesia dan dikenai PPN yang sama. Bentuk antarmukanya tetap per kota
 * karena itulah bentuk yang dibutuhkan begitu ada inventaris di luar negeri,
 * dan mengubahnya nanti berarti menyentuh setiap pemanggil.
 *
 * Tidak ada tabel untuk ini. Tarif pajak berubah lewat undang-undang, bukan
 * lewat panel operator, dan perubahannya perlu dibaca orang sebelum berlaku.
 */
export function createTaxPolicyProvider(defaults: TaxPolicy): TaxPolicyProvider {
  return {
    forCity(): TaxPolicy {
      return defaults
    },
  }
}
