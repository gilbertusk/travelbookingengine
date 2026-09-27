import type { Money } from '@tbe/money'
import type { Booking, CancellationReason, Review, SupplierCode } from './booking.js'
import type { StayDates } from './stay-dates.js'

/**
 * Peristiwa domain: satu untuk setiap transisi, termasuk pembuatan.
 *
 * Terpisah dari peristiwa Kafka di packages/event-contracts, dan harus terpisah.
 * Peristiwa domain adalah catatan audit (NFR-10) — ditulis ke booking_events
 * dalam transaksi yang sama dengan perubahan keadaan, dan boleh lebih rinci
 * daripada yang pantas dibaca service lain. Peristiwa Kafka adalah kontrak
 * publik yang berubah pada irama yang berbeda dan dibaca konsumen yang tidak
 * kita kenal. Pemetaan dari yang satu ke yang lain terjadi di lapisan aplikasi
 * — lihat application/contract-payloads.ts — dan tidak setiap peristiwa domain
 * punya pasangan Kafka.
 *
 * Setiap peristiwa membawa `version`: versi pemesanan SETELAH transisi. Nilai
 * itu menjadi nomor urut di booking_events, dan batasan UNIK pada
 * `(booking_id, sequence)` membuat dua penulis yang sama-sama mengira dirinya
 * menang tidak dapat sama-sama tercatat.
 */

interface EventBase {
  readonly bookingId: string
  readonly version: number
  readonly occurredAt: Date
}

/**
 * Membawa seluruh isi yang dibutuhkan `booking.created`: payment-service
 * membaca `amount` dari sini untuk mengetahui nilai yang boleh ditagih. Tanpa
 * satu bidang pun, pembayaran untuk pemesanan ini akan selalu ditolak
 * `amount_unknown`.
 */
export interface BookingCreated extends EventBase {
  readonly type: 'BookingCreated'
  readonly userId: string
  readonly supplier: SupplierCode
  readonly propertyId: string
  readonly ratePlanRef: string
  readonly stay: StayDates
  readonly guestCount: number
  readonly amount: Money
}

export interface PriceVerified extends EventBase {
  readonly type: 'PriceVerified'
  readonly amount: Money
}

/**
 * Harga supplier berbeda dari harga yang disetujui.
 *
 * `newAmount` adalah nilai yang dibaca payment-service sebagai nilai yang boleh
 * ditagih, sejak peristiwa ini terbit — SEBELUM pengguna menyetujuinya. Itu
 * aman hanya karena pembayaran tidak mungkin dibuat sebelum HELD, dan HELD
 * menuntut harga yang sudah disetujui DAN diverifikasi ulang. Lihat
 * contract-payloads.test.ts, yang memeriksa kesepakatan keduanya.
 */
export interface PriceChanged extends EventBase {
  readonly type: 'PriceChanged'
  readonly previousAmount: Money
  readonly newAmount: Money
}

export interface PriceAccepted extends EventBase {
  readonly type: 'PriceAccepted'
  readonly amount: Money
}

export interface BookingHeld extends EventBase {
  readonly type: 'BookingHeld'
  readonly holdRef: string
  readonly heldUntil: Date
}

export interface HoldExpired extends EventBase {
  readonly type: 'HoldExpired'
  readonly holdRef: string
  readonly heldUntil: Date
}

export interface PaymentRecorded extends EventBase {
  readonly type: 'PaymentRecorded'
  readonly paymentId: string
  readonly amount: Money
}

export interface BookingConfirmed extends EventBase {
  readonly type: 'BookingConfirmed'
  readonly supplier: SupplierCode
  readonly supplierRef: string
}

export interface BookingFailed extends EventBase {
  readonly type: 'BookingFailed'
  readonly paymentId: string
  readonly reason: string
}

export interface BookingRefunded extends EventBase {
  readonly type: 'BookingRefunded'
  readonly paymentId: string
  readonly refundId: string
  readonly amount: Money
}

export interface BookingCancelled extends EventBase {
  readonly type: 'BookingCancelled'
  readonly reason: CancellationReason
}

export interface ReviewRequired extends EventBase {
  readonly type: 'ReviewRequired'
  readonly paymentId: string
  readonly from: Review['from']
  readonly reason: string
}

export type BookingEvent =
  | BookingCreated
  | PriceVerified
  | PriceChanged
  | PriceAccepted
  | BookingHeld
  | HoldExpired
  | PaymentRecorded
  | BookingConfirmed
  | BookingFailed
  | BookingRefunded
  | BookingCancelled
  | ReviewRequired

export type BookingEventType = BookingEvent['type']

/**
 * Seluruh jenis peristiwa sebagai nilai. `satisfies` di bawah menolak jenis
 * yang tidak ada; uji di prisma-schema.test.ts menolak jenis yang terlupa —
 * enum `BookingEventType` di skema harus sama persis dengan daftar ini.
 */
export const BOOKING_EVENT_TYPES = [
  'BookingCreated',
  'PriceVerified',
  'PriceChanged',
  'PriceAccepted',
  'BookingHeld',
  'HoldExpired',
  'PaymentRecorded',
  'BookingConfirmed',
  'BookingFailed',
  'BookingRefunded',
  'BookingCancelled',
  'ReviewRequired',
] as const satisfies readonly BookingEventType[]

/**
 * Satu perubahan pemesanan: keadaan sesudahnya dan peristiwa yang
 * menjelaskannya. Keduanya selalu berjalan bersama — repository menerima
 * pasangan ini, bukan salah satunya, sehingga tidak ada jalan menyimpan
 * keadaan tanpa jejak auditnya.
 */
export interface BookingChange<B extends Booking = Booking> {
  readonly booking: B
  readonly event: BookingEvent
}
