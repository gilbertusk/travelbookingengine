/**
 * Pemberitahuan kepada pengguna (FR-23, FR-28).
 *
 * Satu pemberitahuan adalah satu surel tentang satu perubahan pemesanan. Ia
 * lahir dari dua pintu — peristiwa Kafka yang DIPUTUSKAN service ini sendiri,
 * atau perintah RabbitMQ dari service lain yang MEMINTA pengiriman tertentu —
 * tetapi sesudah itu jalannya sama: dicatat, lalu dikirim oleh penghantar.
 *
 * Yang dicatat sengaja sedikit (Step 24, butir 5): jenis, alasan, dan nilai
 * uang yang disebut surel. Alamat surel dan nama tamu TIDAK dicatat — keduanya
 * ditanyakan ke booking-service tepat sebelum surel disusun, dan hilang dari
 * ingatan begitu surel terkirim.
 */

export const NOTIFICATION_TYPES = [
  'booking_confirmed',
  'booking_failed',
  'booking_cancelled',
  'refund_completed',
  'manual_review',
] as const

export type NotificationType = (typeof NOTIFICATION_TYPES)[number]

/**
 * Nilai uang sebagaimana di atas kawat: satuan terkecil plus mata uang.
 * `type`, bukan `interface`: ia disimpan sebagai JSON, dan hanya alias tipe
 * yang dianggap TypeScript cocok dengan bentuk JSON tanpa asersi.
 */
export type MoneyAmount = {
  readonly amountMinor: number
  readonly currency: 'IDR' | 'USD'
}

export type CancelReason = 'user_request' | 'payment_failed' | 'supplier_rejected' | 'unspecified'

/**
 * Apa yang diperiksa manual. Pemeriksaan kamar (status supplier tidak pasti)
 * dan pemeriksaan pengembalian dana (refund gagal) menjanjikan hal berbeda
 * kepada pengguna, jadi surelnya juga berbeda.
 */
export type ReviewConcern = 'room' | 'refund' | 'unspecified'

/**
 * Fakta yang dibawa pemicu dan tidak dapat ditanyakan ulang ke pemesanan:
 * alasan pembatalan dan nilai pengembalian. Keadaan pemesanan sendiri — sudah
 * dibayar atau belum, kode supplier — selalu dibaca segar saat surel disusun.
 */
export type NotificationContext =
  | { readonly type: 'booking_confirmed' }
  | { readonly type: 'booking_failed' }
  | { readonly type: 'manual_review'; readonly concern: ReviewConcern }
  | {
      readonly type: 'booking_cancelled'
      readonly reason: CancelReason
      readonly refund: MoneyAmount | null
    }
  | { readonly type: 'refund_completed'; readonly amount: MoneyAmount | null }

export type NotificationSource = 'event' | 'command'

/** Permintaan pemberitahuan baru, sebelum dicatat. */
export interface NotificationRequest {
  readonly bookingId: string
  /** `null` bila pemicunya tidak membawa userId; diisi saat pemesanan dibaca. */
  readonly userId: string | null
  readonly dedupeKey: string
  readonly source: NotificationSource
  /** eventId pesan pemicu — jejak sebab-akibat, bukan kunci deduplikasi. */
  readonly sourceMessageId: string
  /**
   * correlationId pesan pemicu. Surel dikirim penghantar, jauh sesudah
   * consumer selesai; tanpa nilai ini log pengirimannya terputus dari alur
   * pemesanan yang menyebabkannya.
   */
  readonly correlationId: string
  readonly context: NotificationContext
}

export type NotificationStatus = 'PENDING' | 'SENDING' | 'SENT' | 'FAILED' | 'SKIPPED' | 'DEAD'

/** Pemberitahuan yang sudah diambil penghantar untuk dikirim. */
export interface ClaimedNotification {
  readonly id: string
  readonly type: NotificationType
  readonly bookingId: string
  readonly userId: string | null
  readonly dedupeKey: string
  /**
   * Percobaan yang SUDAH berakhir tanpa hasil sebelum yang ini — termasuk
   * sewa yang habis karena penghantarnya mati di tengah jalan.
   */
  readonly attempts: number
  readonly correlationId: string
  /**
   * Tanda sewa. Hasil hanya dicatat bila sewa ini masih dipegang: penghantar
   * yang terlambat tidak menimpa hasil penghantar yang mengambil alih.
   */
  readonly leaseUntil: Date
  /** `null` bila isi barisnya tidak lagi dapat diurai (mis. ditulis versi lain). */
  readonly context: NotificationContext | null
}

/**
 * Kunci deduplikasi untuk pemberitahuan yang diputuskan dari peristiwa.
 *
 * Satu jenis pemberitahuan per pemesanan, bukan per peristiwa. Peristiwa yang
 * sama dibaca dua kali, `voucher.issued` yang diterbitkan ulang untuk setiap
 * perintah ganda, dan `booking.confirmed` yang tiba bersama `voucher.issued`
 * semuanya berakhir di kunci yang SAMA — dan batasan UNIK di basis data
 * menolak baris kedua.
 *
 * Pengembalian dana dikunci per refund: satu pemesanan bisa menerima lebih
 * dari satu pengembalian (sebagian, lalu sisanya), dan masing-masing layak
 * dikabarkan.
 */
export function eventDedupeKey(
  type: NotificationType,
  bookingId: string,
  refundId?: string,
): string {
  return refundId === undefined ? `${type}:${bookingId}` : `${type}:${bookingId}:${refundId}`
}

/**
 * Kunci deduplikasi untuk perintah: eventId perintahnya.
 *
 * Perintah adalah permintaan EKSPLISIT. Operator yang meminta surel konfirmasi
 * dikirim ulang memang menginginkan surel kedua; yang tidak boleh terjadi
 * hanyalah perintah yang SAMA — diantar ulang RabbitMQ — menghasilkan dua.
 */
export function commandDedupeKey(commandId: string): string {
  return `command:${commandId}`
}
