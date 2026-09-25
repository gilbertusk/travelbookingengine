import type { Money } from '@tbe/money'
import type { Logger } from '@tbe/shared-kernel'
import type { Payment, Refund, RefundReason, SettledPayment } from '../domain/payment.js'

/**
 * Port yang dipenuhi infrastructure.
 *
 * Satu di antaranya bukan formalitas dan layak disebut lebih dulu:
 * [PaymentGateway]. Seluruh komunikasi ke Midtrans melewatinya, karena sandbox
 * TIDAK DAPAT diperintah gagal sesuai kehendak — dan chaos test Step 28
 * membutuhkan kegagalan yang dapat diperintah. Port ini titik penyuntikannya.
 * Memanggil SDK Midtrans dari tempat lain berarti Step 28 kehilangan satu-satunya
 * tempat ia dapat bekerja.
 */

/**
 * Hasil penyisipan yang dijaga batasan UNIK basis data.
 *
 * Bentuknya sengaja tidak `boolean`: `conflict` membawa baris yang sudah ada,
 * sehingga pemanggil dapat mengembalikan hasil sebelumnya tanpa kueri kedua —
 * dan kueri kedua itulah yang akan menjadi pola "periksa dulu baru tulis" yang
 * ingin dihindari seluruh berkas ini.
 */
export type InsertOutcome<T> =
  { readonly kind: 'inserted' } | { readonly kind: 'conflict'; readonly existing: T }

export interface PaymentRepository {
  findById(id: string): Promise<Payment | undefined>

  /**
   * Menyisipkan pembayaran baru. Batasan UNIK pada `idempotency_key` yang
   * memutuskan pemenang ketika pengguna menekan tombol bayar dua kali (FR-18),
   * bukan pemeriksaan "sudah ada?" di aplikasi.
   */
  insert(payment: Payment): Promise<InsertOutcome<Payment>>

  /** Menyimpan perubahan status pembayaran. */
  update(payment: Payment): Promise<void>

  /**
   * Menyisipkan refund bersama status pembayarannya dalam SATU transaksi.
   *
   * Batasan UNIK pada `request_id` yang memutuskan. Satu transaksi karena dua
   * penulisan terpisah dapat berhenti di tengah, dan yang tertinggal adalah
   * refund tanpa status pembayaran yang menyebutkannya — atau sebaliknya.
   */
  insertRefund(payment: SettledPayment, refund: Refund): Promise<InsertOutcome<Refund>>

  /** Memperbarui refund bersama status pembayarannya, juga satu transaksi. */
  updateRefund(payment: SettledPayment, refund: Refund): Promise<void>
}

/**
 * Hasil pemrosesan satu notifikasi, sebagaimana dicatat di `webhook_events`.
 *
 * Nilai-nilai ini disimpan, bukan hanya dipakai sesaat: pertanyaan "kenapa
 * pembayaran ini gagal padahal penyedia bilang berhasil" hanya dapat dijawab
 * bila `ignored_out_of_order` tercatat.
 */
export const WEBHOOK_OUTCOMES = [
  'applied',
  'ignored_duplicate_status',
  'ignored_out_of_order',
  'rejected_unknown_payment',
  'rejected_amount_mismatch',
] as const

export type WebhookOutcome = (typeof WEBHOOK_OUTCOMES)[number]

export type ClaimResult =
  /** Klaim berhasil. Pemanggil BOLEH memproses, dan hanya dia. */
  | { readonly kind: 'claimed' }
  /** Sudah pernah diproses sampai selesai. Hasil sebelumnya dikembalikan apa adanya. */
  | { readonly kind: 'already_processed'; readonly outcome: WebhookOutcome }
  /**
   * Sudah diklaim tetapi BELUM selesai — proses lain sedang memprosesnya, atau
   * proses sebelumnya mati di tengah. Bukan duplikat yang sudah selesai, dan
   * tidak boleh diperlakukan sebagai berhasil: penyedia harus mengirimnya lagi.
   */
  | { readonly kind: 'in_progress' }

export interface WebhookClaim {
  /** `transaction_id` dari penyedia. Kolomnya UNIK, dan itu seluruh mekanismenya. */
  readonly providerEventId: string
  /** Payload yang SUDAH diredaksi — lihat domain/redaction.ts. */
  readonly payload: unknown
}

/**
 * Buku besar notifikasi. Penegak idempotensi webhook (NFR-07).
 *
 * Bentuk port ini yang membuat idempotensi tidak dapat dilakukan dengan salah.
 * Tidak ada operasi "sudah pernah ada?" yang berdiri sendiri: satu-satunya jalan
 * masuk adalah [claim], yang menyisipkan dan melaporkan hasilnya sekaligus.
 * Pola "periksa dulu baru tulis" tidak dapat ditulis terhadap port ini tanpa
 * menambahkan operasi baru — dan itulah maksudnya.
 */
export interface WebhookLedger {
  claim(claim: WebhookClaim): Promise<ClaimResult>

  /**
   * Menutup klaim dengan hasilnya. Dipanggil SETELAH efeknya tersimpan; klaim
   * yang tidak pernah ditutup tetap `in_progress` dan notifikasi berikutnya
   * akan ditolak agar penyedia mengirimnya lagi.
   */
  complete(providerEventId: string, outcome: WebhookOutcome, paymentId?: string): Promise<void>
}

export interface NotificationSignature {
  readonly orderId: string
  readonly statusCode: string
  /** MENTAH, apa adanya dari penyedia. Lihat domain/signature.ts. */
  readonly grossAmount: string
  readonly signatureKey: string
}

/**
 * Verifikasi tanda tangan, dengan server key yang TIDAK pernah melewati lapisan
 * aplikasi.
 *
 * Keputusannya sendiri hidup di domain/signature.ts; port ini hanya mengikat
 * kuncinya, yang dibaca config.ts dari env. Akibat sampingnya berguna: palsuan
 * untuk pengujian tidak membutuhkan kunci apa pun, sehingga tidak ada nilai yang
 * menyerupai kredensial di dalam berkas uji.
 */
export interface SignatureVerifier {
  isValid(input: NotificationSignature): boolean
}

export interface ChargeRequest {
  /** Menjadi `order_id` di sisi penyedia. Lihat create-payment-intent.ts. */
  readonly paymentId: string
  readonly bookingId: string
  readonly amount: Money
}

export type ChargeResult =
  | { readonly kind: 'created'; readonly redirectUrl: string; readonly providerRef: string }
  /** Ditolak penyedia dan tidak akan berubah dengan dicoba ulang. */
  | { readonly kind: 'rejected'; readonly reason: string }
  /** Penyedia tidak dapat dihubungi. Layak dicoba ulang. */
  | { readonly kind: 'unavailable' }

export interface GatewayRefundRequest {
  readonly gatewayRef: string
  /** Diteruskan ke penyedia sebagai kunci idempotensinya sendiri. */
  readonly requestId: string
  readonly amount: Money
  readonly reason: RefundReason
}

export type GatewayRefundResult =
  | { readonly kind: 'refunded'; readonly providerRef: string }
  | { readonly kind: 'rejected'; readonly reason: string }
  | { readonly kind: 'unavailable' }

export interface PaymentGateway {
  charge(request: ChargeRequest): Promise<ChargeResult>
  refund(request: GatewayRefundRequest): Promise<GatewayRefundResult>
}

/**
 * Peristiwa Kafka.
 *
 * Diterbitkan SETELAH keadaan tersimpan, tidak pernah sebelumnya. Peristiwa
 * yang mendahului penyimpanan akan dibaca consumer yang lalu menanyakan keadaan
 * yang belum ada — dan pada alur pembayaran, consumer itu adalah saga yang
 * mengonfirmasi kamar.
 */
export interface PaymentEvents {
  succeeded(input: {
    readonly paymentId: string
    readonly bookingId: string
    readonly amount: Money
    readonly gatewayRef: string
  }): Promise<void>

  failed(input: {
    readonly paymentId: string
    readonly bookingId: string
    readonly reason: string
  }): Promise<void>

  refunded(input: {
    readonly refundId: string
    readonly paymentId: string
    readonly bookingId: string
    readonly amount: Money
  }): Promise<void>
}

/**
 * Nilai yang boleh ditagih, diturunkan dari peristiwa pemesanan.
 *
 * BUKAN dari permintaan pembuatan pembayaran. G2 menuntut pengguna tidak pernah
 * dibebani nilai selain yang terakhir disetujuinya, dan itu mustahil dijamin
 * kalau nilainya datang dari pemanggil yang sama dengan yang meminta pembayaran.
 */
export interface PayableAmount {
  readonly bookingId: string
  readonly amount: Money
  /** Jenis peristiwa yang menetapkannya: `booking.created` atau `booking.price_changed`. */
  readonly source: string
  /** `occurredAt` peristiwanya, bukan waktu tulis. */
  readonly observedAt: Date
}

export interface PayableAmounts {
  find(bookingId: string): Promise<PayableAmount | undefined>

  /**
   * Menulis hanya bila peristiwanya lebih baru daripada yang tercatat.
   *
   * Kafka menjamin urutan di dalam satu partisi, dan seluruh peristiwa satu
   * pemesanan berkunci bookingId. Yang tidak dijaminnya adalah urutan setelah
   * consumer digandakan dan satu di antaranya tersendat lalu mengejar — dan
   * `booking.created` yang tiba setelah `booking.price_changed` akan memutar
   * harga kembali ke nilai yang sudah tidak disetujui pengguna.
   */
  record(entry: PayableAmount): Promise<void>
}

export interface RateLimitDecision {
  readonly allowed: boolean
  readonly limit: number
  readonly remaining: number
  readonly resetAfterSeconds: number
}

/**
 * Pembatasan laju khusus endpoint webhook.
 *
 * Terpisah dari pembatas di api-gateway, dan harus terpisah: endpoint webhook
 * tidak melewati gateway sama sekali — penyedia memanggilnya langsung — jadi
 * tidak ada pembatas lain yang melindunginya. Tanpa ini, siapa pun yang
 * mengetahui alamatnya dapat membanjirinya dengan notifikasi bertanda tangan
 * palsu, dan setiap satu di antaranya menghabiskan satu perhitungan SHA-512.
 */
export interface WebhookRateLimiter {
  consume(key: string): Promise<RateLimitDecision>
}

export interface Clock {
  now(): Date
}

export interface IdFactory {
  next(): string
}

/** Dependensi seluruh use case. Dirangkai di index.ts, satu-satunya tempat wiring. */
export interface PaymentDeps {
  readonly payments: PaymentRepository
  readonly ledger: WebhookLedger
  readonly payables: PayableAmounts
  readonly gateway: PaymentGateway
  readonly events: PaymentEvents
  readonly verifier: SignatureVerifier
  readonly clock: Clock
  readonly ids: IdFactory
  readonly logger: Logger
}
