import type { MoneyAmount } from './notification.js'

/**
 * Pemesanan sebagaimana dijawab booking-service tepat sebelum surel disusun.
 *
 * Dibaca segar setiap kali, tidak disimpan: keadaan pemesanan menentukan apa
 * yang JUJUR untuk dikatakan (surel "sedang diperiksa" untuk pemesanan yang
 * sudah selesai diperiksa adalah kebohongan kecil), dan alamat surel tidak
 * boleh menetap di basis data service ini.
 */
export interface BookingSnapshot {
  readonly bookingId: string
  readonly userId: string
  readonly status: string
  readonly supplierRef: string | null
  /** Tanggal lokal properti, YYYY-MM-DD. Tidak pernah dikonversi zona. */
  readonly checkIn: string
  readonly checkOut: string
  readonly guestCount: number
  readonly leadGuest: { readonly fullName: string; readonly email: string }
  /** `null` untuk pemesanan sebelum Step 23. */
  readonly roomTypeName: string | null
  readonly total: MoneyAmount
}

/**
 * Keadaan sesudah uang diterima dan pemesanan TIDAK berakhir terkonfirmasi.
 * Pemesanan di sini sudah ditagih, jadi surelnya wajib bicara soal
 * pengembalian dana.
 *
 * NEEDS_REVIEW sengaja TIDAK termasuk: di sana pengembaliannya bisa saja
 * tertahan, dan surel "dana dikembalikan otomatis, kamu tidak perlu melakukan
 * apa pun" menjadi janji yang tidak benar. Surel pemeriksaan manual yang
 * berbicara untuk keadaan itu.
 */
export const CHARGED_FAILURE_STATUSES: readonly string[] = ['FAILED', 'REFUNDED']

/** Keadaan akhir tanpa tagihan. */
export const UNCHARGED_END_STATUSES: readonly string[] = ['CANCELLED', 'EXPIRED']
