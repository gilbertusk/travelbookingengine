import type { Logger } from '@tbe/shared-kernel'
import type { Increment } from '../domain/counters.js'
import type { SupplierCode } from '../domain/facts.js'
import type { CounterRow } from '../domain/summary.js'

/**
 * Port analytics-service (Step 27).
 *
 * Penyimpan memegang tiga hal dan ketiganya dikosongkan BERSAMA saat replay:
 * penghitung, pemetaan bookingId → supplier, dan daftar pesan yang sudah
 * dihitung. Mengosongkan penghitung tanpa daftar pesan membuat replay
 * melewati setiap pesan sebagai duplikat — agregat kosong selamanya.
 */

export interface RecordUnit {
  readonly eventId: string
  readonly eventType: string
  /** Dicatat dari booking.created, untuk fakta berikutnya yang tidak menyebut supplier. */
  readonly bookingSupplier?: { readonly bookingId: string; readonly supplier: SupplierCode }
  readonly increments: readonly Increment[]
}

export type RecordOutcome = 'recorded' | 'duplicate'

export interface DayRange {
  /** YYYY-MM-DD, inklusif. */
  readonly from: string
  readonly to: string
}

export interface AnalyticsStore {
  supplierOf(bookingId: string): Promise<SupplierCode | undefined>
  /**
   * SATU transaksi: tandai pesan sebagai terhitung, catat pemetaan supplier,
   * naikkan penghitung. Pesan yang sudah pernah terhitung tidak mengubah
   * apa pun — Kafka mengantar minimal sekali, dan analitik yang menghitung
   * dua kali saat consumer group menyeimbangkan ulang bukan analitik.
   */
  record(unit: RecordUnit, at: Date): Promise<RecordOutcome>
  counters(range: DayRange): Promise<readonly CounterRow[]>
  processedCount(): Promise<number>
  reset(): Promise<void>
}

export type RewindCheck =
  | { readonly kind: 'idle' }
  | { readonly kind: 'active'; readonly members: number; readonly state: string }

/** Offset consumer group analitik di broker. */
export interface ConsumerOffsets {
  /** Group yang masih punya anggota TIDAK boleh diputar balik: anggotanya menimpa offset lagi. */
  check(groupId: string): Promise<RewindCheck>
  rewindToEarliest(groupId: string, topics: readonly string[]): Promise<void>
}

export interface Clock {
  now(): Date
}

export interface AnalyticsDeps {
  readonly store: AnalyticsStore
  readonly clock: Clock
  readonly logger: Logger
}
