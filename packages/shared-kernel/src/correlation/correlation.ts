import { AsyncLocalStorage } from 'node:async_hooks'
import { v7 as uuidv7 } from 'uuid'

/**
 * Correlation ID yang mengalir sendiri sepanjang satu permintaan.
 *
 * Tanpa ini, setiap fungsi harus menerima correlationId sebagai argumen dan
 * meneruskannya — termasuk fungsi yang tidak peduli sama sekali. AsyncLocalStorage
 * membuat konteks mengikuti alur asinkron tanpa mengotori setiap tanda tangan
 * fungsi di sepanjang jalan.
 *
 * Konteks ini juga dipulihkan di sisi consumer pesan pada Step 05, sehingga log
 * dari saga asinkron tetap terkorelasi dengan permintaan HTTP yang memulainya.
 */

export const CORRELATION_HEADER = 'x-correlation-id'

export interface CorrelationContext {
  readonly correlationId: string
}

const storage = new AsyncLocalStorage<CorrelationContext>()

export function newCorrelationId(): string {
  // UUID v7 terurut menurut waktu, sehingga indeks database tidak terfragmentasi
  // seperti pada v4 yang acak sepenuhnya.
  return uuidv7()
}

export function runWithCorrelation<T>(correlationId: string, fn: () => T): T {
  return storage.run({ correlationId }, fn)
}

export function getCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId
}

/**
 * Mengambil correlationId yang sedang aktif, atau membuat yang baru bila
 * dipanggil di luar konteks mana pun — misalnya dari pekerjaan terjadwal.
 */
export function getOrCreateCorrelationId(): string {
  return getCorrelationId() ?? newCorrelationId()
}
