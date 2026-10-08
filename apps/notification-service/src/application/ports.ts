import type { Logger } from '@tbe/shared-kernel'
import type { BookingSnapshot } from '../domain/booking-snapshot.js'
import type {
  ClaimedNotification,
  NotificationRequest,
  NotificationType,
} from '../domain/notification.js'

/**
 * Port notification-service. Application bergantung pada bentuk-bentuk ini,
 * bukan pada Prisma, nodemailer, atau undici — CONVENTIONS.md bagian 1.
 *
 * Aturan galat yang dipegang setiap adapter, sama dengan voucher-service:
 * "tidak ada" dijawab sebagai NILAI, "tidak dapat ditanyai" DILEMPAR. Yang
 * dilempar berarti dicoba lagi; nilai berarti keputusan.
 */

export type RequestOutcome =
  | { readonly kind: 'created'; readonly id: string }
  /**
   * Batasan UNIK dedupe_key menolak baris kedua. Bila baris yang ada sedang
   * menunggu VOUCHER (`voucher_not_ready`) — masih dijadwalkan ulang, atau
   * sudah DEAD karena vouchernya terlambat — ia dihidupkan dan jadwalnya
   * dimajukan ke sekarang. Itulah cara `voucher.issued` membangunkan surel
   * konfirmasi. Baris yang menunggu karena sebab lain (SMTP mati) tidak
   * disentuh; duplikat tidak boleh melompati jenjang tundanya.
   */
  | { readonly kind: 'duplicate' }

/** Akhir satu percobaan kirim, sebagaimana dicatat. */
export type Settlement =
  | {
      readonly kind: 'sent'
      readonly at: Date
      readonly recipientKey: string
      readonly userId: string
    }
  /** Kegagalan permanen: alamat tidak sah atau ditolak server. Tidak dicoba lagi. */
  | { readonly kind: 'failed'; readonly reason: string; readonly recipientKey: string | null }
  /** Surel tidak layak dikirim — pemesanan tidak ada, atau keadaannya sudah berubah. */
  | { readonly kind: 'skipped'; readonly reason: string }
  | {
      readonly kind: 'retry'
      readonly attempts: number
      readonly nextAttemptAt: Date
      readonly reason: string
    }
  /** Percobaan habis: dead letter. */
  | { readonly kind: 'dead'; readonly attempts: number; readonly reason: string }
  /** Ditahan batas laju. Bukan percobaan, jadi hitungannya tidak naik. */
  | { readonly kind: 'deferred'; readonly until: Date; readonly recipientKey: string }

export interface NotificationRepository {
  request(request: NotificationRequest, now: Date): Promise<RequestOutcome>
  /**
   * Mengambil SATU pemberitahuan yang jatuh tempo dan menyewanya selama
   * `leaseMs`. Satu per satu, bukan satu batch: sewa batch mulai berjalan
   * untuk seluruh baris sekaligus sementara barisnya dikirim berurutan, dan
   * baris di ujung batch kehabisan sewa — lalu dikirim dua kali — sebelum
   * gilirannya tiba. Dua penghantar tidak pernah mengambil baris yang sama;
   * sewa yang habis karena prosesnya mati diambil lagi, dan itu dihitung
   * sebagai satu percobaan.
   */
  claimNext(now: Date, leaseMs: number): Promise<ClaimedNotification | undefined>
  /**
   * Mencatat hasil, HANYA bila sewa `claimed` masih dipegang. `false` berarti
   * sewanya sudah habis dan diambil alih; hasil ini dibuang.
   */
  settle(claimed: ClaimedNotification, settlement: Settlement, now: Date): Promise<boolean>
  /** Surel TERKIRIM ke penerima ini sejak `since`. */
  sentToRecipientSince(recipientKey: string, since: Date): Promise<number>
}

export type SnapshotLookup =
  { readonly kind: 'found'; readonly booking: BookingSnapshot } | { readonly kind: 'not_found' }

export interface BookingDirectory {
  notificationSource(bookingId: string): Promise<SnapshotLookup>
}

export interface VoucherDocuments {
  /** `undefined` bila voucher belum terbit. */
  document(bookingId: string): Promise<Uint8Array | undefined>
}

export interface Attachment {
  readonly filename: string
  readonly contentType: string
  readonly content: Uint8Array
}

export interface OutgoingEmail {
  readonly to: string
  readonly subject: string
  readonly text: string
  readonly html: string
  readonly attachments: readonly Attachment[]
}

/**
 * Hasil pengiriman sebagai NILAI. Pembedaan permanen dan sementara adalah
 * keputusan adapter — hanya ia yang membaca kode balasan SMTP — tetapi apa
 * yang dilakukan dengannya adalah keputusan application.
 *
 * `code` tidak pernah memuat alamat penerima: balasan server SMTP sering
 * menyebut alamatnya, dan `code` disimpan di basis data.
 */
export type SendResult =
  | { readonly kind: 'sent' }
  | { readonly kind: 'permanent'; readonly code: string }
  | { readonly kind: 'transient'; readonly code: string }

export interface EmailSender {
  send(email: OutgoingEmail): Promise<SendResult>
}

export type DeliveryOutcome = Settlement['kind']

export interface DeliveryMetrics {
  delivered(type: NotificationType, outcome: DeliveryOutcome): void
}

export interface Clock {
  now(): Date
}

export interface DeliveryPolicy {
  /** Surel per penerima per jam. */
  readonly ratePerHour: number
  /** Rahasia HMAC kunci penerima. Lihat domain/delivery.ts. */
  readonly recipientKeySecret: string
  readonly batchSize: number
  readonly leaseMs: number
}

export interface NotificationDeps {
  readonly notifications: NotificationRepository
  readonly bookings: BookingDirectory
  readonly vouchers: VoucherDocuments
  readonly sender: EmailSender
  readonly metrics: DeliveryMetrics
  readonly clock: Clock
  readonly policy: DeliveryPolicy
  readonly logger: Logger
}
