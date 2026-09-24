import type { CatalogSource, SnapshotStore, UnmappedQueue } from './ports.js'
import type { SightingBuffer } from './resolve-properties.js'

/**
 * Memuat katalog dari basis data ke Redis.
 *
 * Dipanggil saat startup dan pada penyegaran berkala. TIDAK pada jalur
 * pencarian — seluruh alasan snapshot ada adalah supaya pencarian tidak
 * pernah memanggil yang satu ini.
 */
export async function refreshCatalog(
  source: CatalogSource,
  snapshots: SnapshotStore,
): Promise<{ properties: number; mappings: number }> {
  const contents = await source.load()
  await snapshots.write(contents)

  return { properties: contents.properties.length, mappings: contents.mappings.length }
}

/**
 * Menulis kemunculan properti belum terpetakan yang tertumpuk.
 *
 * Dipanggil berkala, bukan pada setiap pencarian. Pencatatan yang ditunggu
 * permintaan berarti satu penulisan basis data pada jalur kritis untuk sesuatu
 * yang tidak mengubah jawaban yang dikembalikan.
 */
export async function flushSightings(
  buffer: SightingBuffer,
  queue: UnmappedQueue,
  onError: (error: unknown) => void,
): Promise<number> {
  const sightings = buffer.drain()
  if (sightings.length === 0) return 0

  try {
    await queue.recordSeen(sightings)
    return sightings.length
  } catch (error) {
    // Kemunculan yang gagal dicatat TIDAK dikembalikan ke penyangga. Penyangga
    // yang tumbuh karena basis data sedang tumbang akan menghabiskan memori
    // proses, dan penghitung kemunculan yang meleset jauh lebih murah daripada
    // service pencarian yang mati.
    onError(error)
    return 0
  }
}
