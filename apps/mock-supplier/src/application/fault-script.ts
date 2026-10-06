import type { SupplierCode } from '../domain/supplier.js'
import { FAILURE_MODES } from './chaos.js'

/**
 * Kegagalan TERJADWAL untuk satu operasi tertentu (Step 20).
 *
 * Panel kendali yang lama bekerja dengan peluang: "gagal 100% dengan mode X"
 * berlaku untuk SEMUA operasi supplier itu sekaligus. Itu cukup untuk uji beban
 * dan chaos, tetapi tidak dapat menulis skenario US-05 yang paling penting:
 *
 *   book → timeout, TETAPI pemesanannya sudah tersimpan di supplier
 *        → pencarian lewat idempotency key → ketemu → diadopsi
 *
 * Dengan peluang 100%, pencarian ulangnya ikut gagal; dengan peluang di bawah
 * 100%, uji menjadi undian. Keduanya ditolak. Yang dibutuhkan adalah kalimat
 * "operasi `book` berikutnya gagal satu kali dengan mode X" — deterministik,
 * menyasar satu operasi, dan habis sendiri setelah dipakai.
 *
 * Keacakan pada panel lama TIDAK diganti. Step 11 membutuhkannya supaya
 * percobaan ulang dapat berhasil; jadwal ini hanya menambah jalur kedua yang
 * diperiksa lebih dulu.
 */

export const SUPPLIER_OPERATIONS = ['search', 'rate', 'hold', 'book', 'cancel', 'lookup'] as const
export type SupplierOperation = (typeof SUPPLIER_OPERATIONS)[number]

/**
 * `lose_response`: penangannya DIJALANKAN — pemesanan tersimpan — tetapi
 * jawabannya ditahan sampai klien menyerah. Inilah timeout yang berbahaya:
 * dari sisi klien ia tidak dapat dibedakan dari `timeout` biasa, padahal
 * efeknya sudah terjadi. `timeout` biasa menahan permintaan SEBELUM penangan,
 * jadi tidak ada efek apa pun.
 */
export const SCRIPTED_MODES = [...FAILURE_MODES, 'lose_response'] as const
export type ScriptedMode = (typeof SCRIPTED_MODES)[number]

export interface ScriptedFault {
  readonly operation: SupplierOperation
  readonly mode: ScriptedMode
  /** Berapa kali lagi kegagalan ini berlaku sebelum habis. */
  readonly times: number
}

export interface FaultScript {
  add(code: SupplierCode, fault: ScriptedFault): readonly ScriptedFault[]
  /** Mengambil SATU kegagalan untuk operasi ini, bila ada, dan mengurangi sisanya. */
  take(code: SupplierCode, operation: SupplierOperation): ScriptedMode | undefined
  pending(code: SupplierCode): readonly ScriptedFault[]
  clear(): void
}

export function createFaultScript(): FaultScript {
  const script = new Map<SupplierCode, readonly ScriptedFault[]>()
  const pending = (code: SupplierCode): readonly ScriptedFault[] => script.get(code) ?? []

  return {
    add(code, fault) {
      const next = [...pending(code), fault]
      script.set(code, next)
      return next
    },
    take(code, operation) {
      const faults = pending(code)
      const index = faults.findIndex((fault) => fault.operation === operation)
      const found = faults[index]
      if (found === undefined) return undefined

      // Urutan pendaftaran dipertahankan: kegagalan pertama yang cocok yang
      // dipakai, dan yang habis dibuang. Tidak ada larik yang diubah di tempat.
      const remaining = found.times - 1
      const next =
        remaining > 0
          ? faults.map((fault, at) => (at === index ? { ...fault, times: remaining } : fault))
          : faults.filter((_, at) => at !== index)
      script.set(code, next)

      return found.mode
    },
    pending,
    clear() {
      script.clear()
    },
  }
}
