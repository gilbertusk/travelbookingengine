import type { RawSupplierProperty, SearchProperty } from '../domain/property.js'
import type { CatalogSnapshot, UnmappedSighting } from './ports.js'

/**
 * Menyelesaikan properti yang dikembalikan supplier menjadi properti internal.
 *
 * Dua aturan yang mengikat di sini, dan keduanya diuji:
 *
 * 1. **Tidak menyentuh basis data.** Hanya [CatalogSnapshot], yang dibaca dari
 *    Redis. Fungsi ini dipanggil sekali untuk setiap properti dari setiap
 *    supplier — ratusan kali per pencarian.
 *
 * 2. **Properti belum terpetakan tetap dikembalikan.** Apa adanya, memakai
 *    data mentah supplier, ditandai, dan tanpa slug. Menyembunyikannya berarti
 *    kehilangan inventaris, dan agregator yang membuang inventaris karena
 *    pemetaannya belum ada sedang merugikan dirinya sendiri demi kerapian
 *    basis data.
 *
 * Pencatatan properti belum terpetakan TIDAK ditunggu. Ia dikumpulkan ke
 * penyangga dan ditulis belakangan oleh [flushSightings]; permintaan pencarian
 * tidak pernah menunggu satu pun penulisan.
 */

export interface ResolveResult {
  readonly properties: readonly SearchProperty[]
  /** Pengenal properti internal, dikelompokkan — satu hotel, banyak supplier. */
  readonly bySupplier: ReadonlyMap<string, readonly string[]>
}

export function resolveProperties(
  snapshot: CatalogSnapshot,
  raw: readonly RawSupplierProperty[],
  buffer: SightingBuffer,
): ResolveResult {
  const properties: SearchProperty[] = []
  const bySupplier = new Map<string, string[]>()
  const seen = new Set<string>()

  for (const item of raw) {
    const propertyId = snapshot.propertyId(item.supplierId, item.supplierPropertyId)
    const property = propertyId === undefined ? undefined : snapshot.property(propertyId)

    if (propertyId === undefined || property === undefined) {
      // Terpetakan tetapi propertinya tidak ada di snapshot berarti snapshot
      // sedang tidak konsisten — diperlakukan sama dengan belum terpetakan,
      // supaya inventarisnya tetap tampil alih-alih hilang tanpa jejak.
      buffer.add(item)
      properties.push({
        kind: 'unmapped',
        supplierId: item.supplierId,
        supplierPropertyId: item.supplierPropertyId,
        name: item.name,
        ...(item.address === undefined ? {} : { address: item.address }),
        ...(item.city === undefined ? {} : { city: item.city }),
        ...(item.latitude === undefined ? {} : { latitude: item.latitude }),
        ...(item.longitude === undefined ? {} : { longitude: item.longitude }),
      })
      continue
    }

    const suppliers = bySupplier.get(propertyId)
    if (suppliers === undefined) bySupplier.set(propertyId, [item.supplierId])
    else suppliers.push(item.supplierId)

    // Satu entri per properti internal, meski tiga supplier menjualnya.
    // Inilah FR-04 pada tingkat hasil.
    if (seen.has(propertyId)) continue
    seen.add(propertyId)
    properties.push({ kind: 'mapped', property })
  }

  return { properties, bySupplier }
}

/**
 * Penyangga kemunculan properti belum terpetakan.
 *
 * Menggabungkan kemunculan berulang di dalam memori lebih dulu. Satu
 * pencarian di Bali dapat memunculkan properti yang sama dari lima supplier,
 * dan lima penulisan untuk satu kenyataan adalah empat penulisan yang
 * sia-sia — pada jalur yang paling sensitif terhadap waktu.
 */
export interface SightingBuffer {
  add(item: RawSupplierProperty): void
  drain(): readonly UnmappedSighting[]
  readonly size: number
}

export function createSightingBuffer(maxEntries = 10_000): SightingBuffer {
  const entries = new Map<string, UnmappedSighting>()

  return {
    get size() {
      return entries.size
    },

    add(item) {
      const key = `${item.supplierId}:${item.supplierPropertyId}`
      const existing = entries.get(key)

      if (existing !== undefined) {
        entries.set(key, { ...existing, occurrences: existing.occurrences + 1 })
        return
      }

      // Batasnya ada supaya supplier yang tiba-tiba mengembalikan ribuan
      // properti baru tidak menumbuhkan penyangga tanpa henti. Kemunculan
      // yang terlewat lebih baik daripada proses yang kehabisan memori.
      if (entries.size >= maxEntries) return

      entries.set(key, {
        supplierId: item.supplierId,
        supplierPropertyId: item.supplierPropertyId,
        rawName: item.name,
        ...(item.address === undefined ? {} : { rawAddress: item.address }),
        ...(item.city === undefined ? {} : { rawCity: item.city }),
        ...(item.latitude === undefined ? {} : { latitude: item.latitude }),
        ...(item.longitude === undefined ? {} : { longitude: item.longitude }),
        occurrences: 1,
      })
    },

    drain() {
      const drained = [...entries.values()]
      entries.clear()
      return drained
    },
  }
}
