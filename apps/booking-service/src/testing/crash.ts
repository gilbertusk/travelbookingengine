import type { SagaStore, SagaUnit } from '../application/ports.js'
import type { MemoryHoldStore } from './fakes.js'

/**
 * Proses yang mati di titik tertentu.
 *
 * Proses yang mati tidak menjalankan `catch` maupun `finally` apa pun — ia
 * berhenti. Yang paling dekat dengan itu di dalam satu proses uji adalah
 * galat yang tidak ditangkap siapa pun sampai ke uji: tidak ada kode
 * produksi di jalur ini yang menangkap galat umum, jadi galat ini merambat
 * persis seperti proses yang berhenti. Setelahnya uji memanggil `restart()`,
 * yang membuang seluruh keadaan di memori proses lama.
 */
export class SimulatedCrash extends Error {
  constructor(where: string) {
    super(`proses mati: ${where}`)
  }
}

/**
 * Hold store yang prosesnya mati SEKALI, tepat setelah Redis menjawab —
 * kursi sudah diambil atau dilepas di Redis, tetapi proses tidak sempat
 * mencatat apa pun sesudahnya.
 */
export function crashingHoldStore(inner: MemoryHoldStore, at: 'after-acquire'): MemoryHoldStore {
  let armed = true

  return {
    ...inner,
    acquire: async (claim) => {
      const outcome = await inner.acquire(claim)
      if (armed) {
        armed = false
        throw new SimulatedCrash(at)
      }
      return outcome
    },
  }
}

/**
 * Penyimpan saga yang prosesnya mati SEKALI, tepat setelah transaksi yang
 * cocok ter-commit — sebelum apa pun sesudahnya, termasuk kompensasi langsung
 * yang niatnya baru saja tercatat.
 */
export function crashAfterCommit(
  inner: SagaStore,
  matches: (unit: SagaUnit) => boolean,
): SagaStore {
  let armed = true

  return {
    ...inner,
    commit: async (unit) => {
      const outcome = await inner.commit(unit)
      if (armed && matches(unit)) {
        armed = false
        throw new SimulatedCrash('setelah commit')
      }
      return outcome
    },
  }
}
