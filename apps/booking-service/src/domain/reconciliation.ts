import { toDecimalString, type Money } from '@tbe/money'
import type { SupplierCode } from './booking.js'
import { isSameAmount } from './price.js'
import type { StayDates } from './stay-dates.js'

/**
 * Rekonsiliasi dengan supplier (Step 28, FR-33) — perbandingan murni.
 *
 * Satu pemesanan kita, satu jawaban supplier, satu putusan. Tidak ada I/O di
 * sini, dan tidak ada keputusan tentang apa yang DILAKUKAN dengan putusannya:
 * lapisan aplikasi memindahkannya ke peninjauan, dan hanya itu.
 *
 * Keadaan kita yang diperiksa — dan kenapa hanya ini:
 *
 * - **CONFIRMED**: harus ada dan aktif di supplier, dengan nilai dan tanggal
 *   yang sama.
 * - **REFUNDED**: uang sudah kembali; pemesanan TIDAK boleh aktif di supplier.
 *   Inilah tempat pemesanan bayangan bersembunyi — konfirmasi yang dianggap
 *   gagal padahal berhasil, lalu direfund.
 * - **CANCELLED yang sudah dibayar** (dibatalkan pengguna, Step 25): kamar
 *   seharusnya sudah lepas.
 *
 * Yang TIDAK diperiksa: keadaan tengah (saga masih bergerak, dan putusan atas
 * keadaan yang sedang berpindah adalah putusan atas kebetulan waktu),
 * NEEDS_REVIEW (sudah di depan manusia), dan pemesanan yang tidak pernah
 * dibayar (tidak pernah dikirim ke supplier untuk dikonfirmasi).
 */

export type ReconciledStatus = 'CONFIRMED' | 'REFUNDED' | 'CANCELLED'

/** Catatan supplier yang sudah diterjemahkan adapter ke bentuk kanonis. */
export interface SupplierRecord {
  readonly status: 'CONFIRMED' | 'CANCELLED'
  readonly total: Money
  /** Tidak setiap supplier mengembalikan tanggal pada pencarian pemesanan. */
  readonly checkIn?: string | undefined
  readonly checkOut?: string | undefined
}

export type LedgerAnswer =
  | { readonly kind: 'found'; readonly record: SupplierRecord }
  /** Supplier menjawab dengan sah bahwa ia tidak menyimpannya. */
  | { readonly kind: 'not_found' }
  /** Tidak ada jawaban yang dapat dipercaya: timeout, pemutus terbuka, galat supplier. */
  | { readonly kind: 'unreachable' }

export interface LocalRecord {
  readonly status: ReconciledStatus
  readonly supplier: SupplierCode
  /** Pegangan yang dipakai bertanya — dicantumkan di alasan untuk peninjau. */
  readonly handle: string
  readonly stay: StayDates
  /**
   * Harga bersih supplier saat hold, dari peristiwa BookingHeld. `undefined`
   * untuk pemesanan sebelum Step 28: nilainya tidak dibandingkan, dan
   * putusannya menyebut itu, alih-alih membandingkan dengan harga jual yang
   * memuat markup.
   */
  readonly supplierTotal: Money | undefined
}

export const MISMATCH_KINDS = [
  /** CONFIRMED di sini, supplier tidak menyimpannya sama sekali. */
  'missing_at_supplier',
  /** CONFIRMED di sini, supplier mencatatnya dibatalkan. */
  'cancelled_at_supplier',
  /** Direfund atau dibatalkan di sini, masih aktif di supplier — pemesanan bayangan. */
  'active_at_supplier',
  'amount_mismatch',
  'dates_mismatch',
] as const

export type MismatchKind = (typeof MISMATCH_KINDS)[number]

export type Verdict =
  | { readonly kind: 'match'; readonly note?: string }
  /** Supplier tidak dapat ditanya. BUKAN ketidaksesuaian: tidak ada yang diketahui. */
  | { readonly kind: 'unverified' }
  | { readonly kind: 'mismatch'; readonly mismatch: MismatchKind; readonly reason: string }

export function compare(local: LocalRecord, answer: LedgerAnswer): Verdict {
  if (answer.kind === 'unreachable') return { kind: 'unverified' }

  return local.status === 'CONFIRMED'
    ? compareConfirmed(local, answer)
    : compareReleased(local, answer)
}

const where = (local: LocalRecord): string => `supplier ${local.supplier} (${local.handle})`

function compareConfirmed(
  local: LocalRecord,
  answer: Exclude<LedgerAnswer, { kind: 'unreachable' }>,
): Verdict {
  if (answer.kind === 'not_found') {
    return mismatch('missing_at_supplier', `CONFIRMED di sini, tidak ditemukan di ${where(local)}`)
  }

  const record = answer.record
  if (record.status === 'CANCELLED') {
    return mismatch(
      'cancelled_at_supplier',
      `CONFIRMED di sini, tercatat DIBATALKAN di ${where(local)}`,
    )
  }

  if (local.supplierTotal !== undefined && !isSameAmount(local.supplierTotal, record.total)) {
    return mismatch(
      'amount_mismatch',
      `nilai berbeda: ${amount(local.supplierTotal)} saat hold, ${amount(record.total)} di ${where(local)}`,
    )
  }

  const datesDiffer =
    (record.checkIn !== undefined && record.checkIn !== local.stay.checkIn) ||
    (record.checkOut !== undefined && record.checkOut !== local.stay.checkOut)
  if (datesDiffer) {
    return mismatch(
      'dates_mismatch',
      `tanggal berbeda: ${local.stay.checkIn}–${local.stay.checkOut} di sini, ` +
        `${record.checkIn ?? '?'}–${record.checkOut ?? '?'} di ${where(local)}`,
    )
  }

  return local.supplierTotal === undefined
    ? { kind: 'match', note: 'nilai tidak dibandingkan: harga supplier saat hold tidak tercatat' }
    : { kind: 'match' }
}

/**
 * REFUNDED dan CANCELLED: tidak ditemukan atau dibatalkan di supplier sama-sama
 * cocok. Nilai dan tanggal tidak berarti apa-apa untuk pemesanan yang memang
 * tidak boleh ada.
 */
function compareReleased(
  local: LocalRecord,
  answer: Exclude<LedgerAnswer, { kind: 'unreachable' }>,
): Verdict {
  if (answer.kind === 'found' && answer.record.status === 'CONFIRMED') {
    return mismatch('active_at_supplier', `${local.status} di sini, masih AKTIF di ${where(local)}`)
  }

  return { kind: 'match' }
}

function mismatch(kind: MismatchKind, detail: string): Verdict {
  return { kind: 'mismatch', mismatch: kind, reason: `rekonsiliasi: ${detail}` }
}

function amount(value: Money): string {
  return `${toDecimalString(value)} ${value.currency}`
}
