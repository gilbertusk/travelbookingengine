import { refreshCatalog } from '../application/catalog-refresh.js'
import type { CatalogSnapshot, CatalogSource, SnapshotStore } from '../application/ports.js'

/**
 * Snapshot katalog yang dipegang proses.
 *
 * Inilah lapis ketiga yang membuat jalur pencarian tidak menyentuh jaringan
 * sama sekali. Redis menyimpan salinan bersama antar instance; yang dibaca
 * setiap pencarian adalah salinan di memori ini.
 *
 * Diperbarui lewat denyut berkala, bukan lewat pembatalan saat berubah.
 * Katalog berubah beberapa kali sehari, dan data statis yang tertinggal
 * beberapa menit tidak merugikan siapa pun — sementara mekanisme pembatalan
 * yang benar antar instance jauh lebih rumit daripada yang dibayarnya.
 *
 * Pengecualian: pemetaan manual operator MEMBUANG salinan di Redis seketika,
 * supaya operator melihat hasil kerjanya tanpa menunggu satu denyut penuh.
 */

export interface SnapshotHolder {
  /** Snapshot saat ini. Sinkron — jalur pencarian tidak boleh menunggu apa pun. */
  current(): CatalogSnapshot | undefined
  /** Memuat dari Redis; bila kosong, memuat dari basis data lalu mengisi Redis. */
  refresh(): Promise<'from_cache' | 'from_database' | 'failed'>
  readonly loadedAt: number | undefined
}

export interface SnapshotHolderOptions {
  readonly snapshots: SnapshotStore
  readonly source: CatalogSource
  readonly now: () => number
  readonly onError: (error: unknown) => void
}

export function createSnapshotHolder(options: SnapshotHolderOptions): SnapshotHolder {
  let snapshot: CatalogSnapshot | undefined
  let loadedAt: number | undefined

  return {
    current: () => snapshot,

    get loadedAt() {
      return loadedAt
    },

    async refresh() {
      try {
        const cached = await options.snapshots.read()
        if (cached !== undefined) {
          snapshot = cached
          loadedAt = options.now()
          return 'from_cache'
        }

        // Redis kosong atau tumbang. Basis data adalah sumber kebenaran, dan
        // memuat darinya di sini TIDAK melanggar aturan apa pun: yang dilarang
        // menyentuh basis data adalah jalur pencarian, bukan penyegaran.
        await refreshCatalog(options.source, options.snapshots)

        const loaded = await options.snapshots.read()
        if (loaded === undefined) {
          // Redis tumbang untuk menulis DAN membaca. Snapshot lama tetap
          // dipakai — katalog yang tertinggal jauh lebih baik daripada tidak
          // ada katalog sama sekali, yang membuat setiap properti tampil
          // sebagai belum terpetakan.
          options.onError(new Error('katalog tidak dapat dimuat dari cache maupun basis data'))
          return 'failed'
        }

        snapshot = loaded
        loadedAt = options.now()
        return 'from_database'
      } catch (error) {
        options.onError(error)
        return 'failed'
      }
    },
  }
}
