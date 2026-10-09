import type { CommandPayload, CommandType } from '@tbe/event-contracts'
import type { Money } from '@tbe/money'
import type { Logger } from '@tbe/shared-kernel'
import type { Booking, DraftBooking, SupplierCode } from '../domain/booking.js'
import type { BookingGroup } from '../domain/booking-groups.js'
import type { LocalDate } from '../domain/stay-dates.js'
import type { BookingChange } from '../domain/events.js'
import type { CancellationPolicy } from '../domain/offer-terms.js'
import type { IdempotencyKey } from '../domain/idempotency-key.js'
import type { RetryPolicy, SagaState } from '../domain/saga-state.js'
import type { SellQuote } from '../domain/sell-price.js'

/**
 * Port yang dipenuhi infrastructure.
 *
 * Hanya satu di Step 16, dan bentuknya yang membawa seluruh keputusannya:
 * **tidak ada operasi yang menyimpan pemesanan tanpa peristiwanya, dan tidak
 * ada operasi yang menulis peristiwa tanpa pemesanannya.** Keduanya masuk
 * sebagai satu [BookingChange]. Implementasi yang menulis keduanya di dua
 * transaksi terpisah masih dapat ditulis — port tidak dapat mencegahnya — tetapi
 * tidak ada pemanggil yang dapat meminta salah satunya saja.
 *
 * Tidak ada `update` dan `delete` untuk peristiwa. booking_events hanya
 * bertambah (NFR-10).
 */

/**
 * Hasil pembuatan, dijaga batasan UNIK `(user_id, idempotency_key)`.
 *
 * `duplicate` membawa pemesanan yang sudah ada, sehingga pemanggil
 * mengembalikannya tanpa kueri kedua — kueri kedua itulah pola "periksa dulu
 * baru tulis" yang punya celah balapan (FR-18, Step 17).
 */
export type CreateOutcome =
  { readonly kind: 'created' } | { readonly kind: 'duplicate'; readonly existing: Booking }

/**
 * Hasil penyimpanan transisi, dijaga kunci versi.
 *
 * `stale` berarti pemesanan sudah dipindahkan pihak lain sejak dibaca — jalur
 * keyspace dan penyapu yang sama-sama mengedaluwarsakan hold, atau pembayaran
 * yang tiba bersamaan dengan kedaluwarsa. Tidak ada yang ditulis, dan
 * `current` adalah keadaan yang menang, supaya pemanggil dapat memutuskan
 * ulang atas keadaan yang sebenarnya.
 */
export type SaveOutcome =
  { readonly kind: 'saved' } | { readonly kind: 'stale'; readonly current: Booking | undefined }

/**
 * Step 19: setiap penyimpanan pemesanan — `create` dan `save` di bawah —
 * juga menulis padanan Kafka peristiwa domainnya ke OUTBOX, dalam transaksi
 * yang sama. Pemanggil tidak dapat lupa menerbitkannya, karena tidak ada
 * pemanggil yang menerbitkan apa pun: penerbit terpisah membaca outbox.
 */
export interface BookingRepository {
  findById(id: string): Promise<Booking | undefined>

  /**
   * Pencarian dengan kunci idempotensi SELALU bersama pemiliknya. Kunci dikirim
   * klien; dua pengguna dapat mengirim kunci yang sama, dan mencari tanpa
   * `userId` berarti mengembalikan pemesanan orang lain.
   */
  findByIdempotencyKey(userId: string, key: IdempotencyKey): Promise<Booking | undefined>

  /** Menyisipkan pemesanan baru beserta peristiwa pembuatannya, satu transaksi. */
  create(change: BookingChange<DraftBooking>): Promise<CreateOutcome>

  /**
   * Menyimpan hasil transisi beserta peristiwanya, satu transaksi — hanya bila
   * versi yang tersimpan masih versi sebelum transisi ini.
   */
  save(change: BookingChange): Promise<SaveOutcome>

  /**
   * Pemesanan HELD yang batas waktunya sudah lewat, yang paling lama lebih
   * dulu. Dibaca penyapu hold (Step 17) lewat indeks `(status, held_until)`.
   */
  findExpiredHolds(now: Date, limit: number): Promise<readonly Booking[]>

  /**
   * Pemesanan CANCELLING yang batas menunggu jawaban supplier atau refundnya
   * sudah lewat (Step 25), yang paling lama lebih dulu.
   */
  findOverdueCancellations(now: Date, limit: number): Promise<readonly Booking[]>

  /**
   * Pemesanan milik pengguna dalam satu kelompok daftar (Step 26), berhalaman.
   * Pencarian SELALU bersama pemiliknya, seperti kunci idempotensi.
   */
  findByUser(query: UserBookingsQuery): Promise<readonly Booking[]>
}

export interface UserBookingsQuery {
  readonly userId: string
  readonly group: BookingGroup
  /** Tanggal kalender UTC hari ini — batas "akan datang" dan "selesai". */
  readonly today: LocalDate
  readonly offset: number
  readonly limit: number
}

/**
 * Jawaban supplier-service, sudah dipetakan ke keputusan booking-service.
 *
 * Bentuknya dipilih dari apa yang dapat DILAKUKAN pemanggil, bukan dari status
 * HTTP: `rejected` berarti supplier menjawab dan jawabannya tidak — kamar habis
 * atau rate plan tidak ada — dan mengulanginya tidak akan mengubah apa pun;
 * `unreachable` berarti belum ada jawaban — timeout, pemutus terbuka, galat
 * 5xx — dan pengguna boleh mencoba lagi. Menyatukan keduanya akan membatalkan
 * pemesanan karena supplier sedang lambat sesaat.
 */
export type SupplierAnswer<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'rejected'; readonly reason: 'sold_out' | 'not_found' }
  | { readonly kind: 'unreachable' }

export interface RatePlanStay {
  readonly supplier: SupplierCode
  readonly supplierRatePlanId: string
  readonly checkIn: string
  readonly checkOut: string
}

/** Jawaban price check: harga supplier dan kebijakan pembatalan rate plan (Step 25). */
export interface SupplierPrice {
  readonly total: Money
  readonly policy: CancellationPolicy
}

export interface SupplierHold {
  readonly holdRef: string
  readonly expiresAt: Date
  readonly total: Money
}

/**
 * Pintu ke supplier-service. Seluruh price check dan hold ke supplier
 * melewatinya.
 *
 * TIDAK ADA operasi pelepasan hold. Bukan kelalaian port ini: tidak satu pun
 * supplier simulasi, adapter di @tbe/supplier-adapters, maupun supplier-service
 * menyediakannya. Hold di supplier kedaluwarsa sendiri pada `expiresAt`-nya.
 * Lihat bagian Temuan di docs/plan/step-17-hold-price-check.md.
 */
export interface SupplierQuotes {
  /** Harga supplier, langsung dari supplier. Tidak pernah dari cache (FR-13). */
  priceCheck(request: RatePlanStay): Promise<SupplierAnswer<SupplierPrice>>
  hold(request: RatePlanStay & { readonly guests: number }): Promise<SupplierAnswer<SupplierHold>>
}

export interface PricingRequest {
  readonly ref: string
  readonly supplier: SupplierCode
  readonly city: string
  readonly supplierTotal: Money
}

/** pricing-service. `undefined` berarti harga tidak dapat dihitung. */
export interface Pricing {
  sellPrice(request: PricingRequest): Promise<SellQuote | undefined>
}

/**
 * Jawaban payment-service atas permintaan membuka pembayaran (Step 21).
 *
 * `not_ready`: payment-service belum mengenal harga yang disetujui — peristiwa
 * pemesanan dari outbox belum sampai, atau harga yang baru disetujui belum
 * terbaca. Sementara, dan pengguna boleh mencoba lagi. `settled`: pembayaran
 * untuk pemesanan ini sudah tidak menunggu; yang tersisa hanyalah statusnya.
 */
export type PaymentStart =
  | {
      readonly kind: 'started'
      readonly paymentId: string
      readonly redirectUrl: string
      readonly snapToken: string
    }
  | { readonly kind: 'settled'; readonly paymentId: string; readonly status: string }
  | { readonly kind: 'not_ready' }
  | { readonly kind: 'rejected' }
  | { readonly kind: 'unreachable' }

export interface PaymentStartRequest {
  readonly bookingId: string
  readonly idempotencyKey: string
  readonly amount: Money
}

/**
 * Pintu ke payment-service. Satu-satunya jalan pengguna membuka pembayaran:
 * payment-service tidak mengenal pemilik pemesanan, jadi kepemilikan dan
 * keadaan HELD diperiksa di sini lebih dulu (lihat start-payment.ts).
 */
export interface Payments {
  start(request: PaymentStartRequest): Promise<PaymentStart>
}

export type AcquireOutcome = 'held' | 'already_held' | 'sold_out'

export interface HoldClaim {
  readonly bookingId: string
  /** Rate plan dan rentang tanggal. Satu hitungan ketersediaan per slot. */
  readonly slot: string
  /**
   * Ketersediaan yang terlihat pengguna saat mencari. Dipakai HANYA untuk
   * slot yang belum pernah dilihat; slot yang sudah ada tidak dapat dinaikkan
   * kapasitasnya oleh permintaan berikutnya.
   */
  readonly capacity: number
  readonly until: Date
}

export interface HoldEntry {
  readonly bookingId: string
  readonly slot: string
}

/**
 * Hold lokal (Redis). Lapis yang menjamin US-04: M permintaan serentak untuk N
 * ketersediaan, tepat N yang berhasil.
 *
 * Seperti `WebhookLedger` di payment-service, port ini sengaja tidak punya
 * operasi "masih ada tempat?" yang berdiri sendiri. Satu-satunya jalan masuk
 * adalah [acquire], yang memeriksa dan mengurangi dalam SATU operasi atomik.
 * Pola baca-lalu-tulis tidak dapat ditulis terhadap port ini.
 */
export interface HoldStore {
  acquire(claim: HoldClaim): Promise<AcquireOutcome>
  /** Memajukan kedaluwarsa hold lokal ke `until` bila lebih awal. Tidak pernah memundurkan. */
  shorten(bookingId: string, until: Date): Promise<void>
  /** Idempoten: `true` hanya untuk pemanggil yang benar-benar melepaskannya. */
  release(entry: HoldEntry): Promise<boolean>
  /** Hold yang masih memegang slot tetapi kunci waktunya sudah hilang. */
  orphans(limit: number): Promise<readonly HoldEntry[]>
}

/** Perintah RabbitMQ yang ditulis ke outbox. Kontraknya di @tbe/event-contracts. */
export type OutboundCommand = {
  readonly [T in CommandType]: { readonly type: T; readonly payload: CommandPayload<T> }
}[CommandType]

/** Pesan Kafka yang efeknya sedang disimpan — dicatat supaya efeknya tidak terjadi dua kali. */
export interface ConsumedMessage {
  readonly eventId: string
  readonly eventType: string
}

/**
 * Satu unit kerja saga: SATU transaksi basis data.
 *
 * Semua yang ada di dalamnya tersimpan bersama atau tidak sama sekali —
 * perubahan pemesanan beserta jejak auditnya, keadaan saga, perintah dan
 * peristiwa untuk outbox, dan catatan bahwa pesan pemicunya sudah dikonsumsi.
 * Tidak ada jendela di mana keadaan sudah berubah tetapi perintah kompensasinya
 * belum tercatat, atau sebaliknya.
 */
export interface SagaUnit {
  readonly bookingId: string
  /** Waktu keputusan. Menjadi waktu kejadian perintah di outbox. */
  readonly at: Date
  /** Transisi pemesanan, dijaga kunci versinya. */
  readonly change?: BookingChange
  /** Keadaan saga, dijaga kunci versinya. Versi 1 berarti saga baru. */
  readonly saga?: SagaState
  readonly commands?: readonly OutboundCommand[]
  readonly consumed?: ConsumedMessage
}

/**
 * `stale`: pemesanan atau saga sudah dipindahkan pihak lain sejak dibaca;
 * tidak ada yang ditulis, dan pemanggil membaca ulang lalu memutuskan ulang.
 * `already_consumed`: pesan pemicunya sudah pernah dikonsumsi; tidak ada yang
 * ditulis, dan itu jawaban yang benar — efeknya sudah terjadi sekali.
 */
export type CommitOutcome = 'committed' | 'stale' | 'already_consumed'

export interface SagaStore {
  find(bookingId: string): Promise<SagaState | undefined>
  commit(unit: SagaUnit): Promise<CommitOutcome>
  /** Saga yang batas menunggu jawabannya sudah lewat. */
  findDue(now: Date, limit: number): Promise<readonly SagaState[]>
  /** Saga yang sewa prosesnya sudah lewat: prosesnya mati di tengah langkah langsung. */
  findLeaseExpired(now: Date, limit: number): Promise<readonly SagaState[]>
}

export interface SagaPolicy {
  /**
   * Sewa proses untuk langkah langsung (hold lokal, hold supplier, pelepasan
   * hold). Harus lebih panjang dari langkah terlama — lihat config.ts, yang
   * menolak sewa yang lebih pendek dari batas waktu panggilan ke supplier.
   */
  readonly leaseMs: number
  /** Batas menunggu jawaban supplier.confirm sebelum saga menyerah (US-05). */
  readonly confirmTimeoutMs: number
  /** Batas menunggu konfirmasi refund sebelum kompensasi dianggap gagal. */
  readonly awaitRefundTimeoutMs: number
  readonly compensationRetry: RetryPolicy
  readonly sweepBatch: number
}

/**
 * Properti dari katalog search-service: nama untuk ditampilkan (Step 26) dan
 * zona waktu untuk tenggat pembatalan (Step 25).
 *
 * Ditanyakan saat pembatalan dihitung, bukan disalin saat memesan: zona waktu
 * adalah fakta properti (CONVENTIONS.md bagian 9), bukan bagian kesepakatan,
 * dan katalog adalah pemiliknya. Yang disepakati — jadwal pengembaliannya —
 * tersimpan bersama pemesanan.
 *
 * `not_found`: properti tidak terpetakan di katalog. Pembatalannya tidak dapat
 * dihitung otomatis, dan TIDAK ditebak dengan zona lain: selisih beberapa jam
 * di sekitar tenggat berarti persentase pengembalian yang lain.
 */
export type PropertyAnswer =
  | { readonly kind: 'found'; readonly name: string; readonly timeZone: string }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'unreachable' }

export interface PropertyDirectory {
  lookup(supplier: SupplierCode, propertyId: string): Promise<PropertyAnswer>
}

export interface Clock {
  now(): Date
}

export interface IdFactory {
  next(): string
}

export interface HoldPolicy {
  /** Durasi hold lokal. */
  readonly durationMs: number
  /** Banyak pemesanan yang diproses penyapu per putaran. */
  readonly sweepBatch: number
}

/** Dependensi seluruh use case. Dirangkai di index.ts, satu-satunya tempat wiring. */
export interface BookingDeps {
  readonly bookings: BookingRepository
  readonly sagas: SagaStore
  readonly sagaPolicy: SagaPolicy
  readonly suppliers: SupplierQuotes
  readonly pricing: Pricing
  readonly properties: PropertyDirectory
  readonly holds: HoldStore
  readonly clock: Clock
  readonly ids: IdFactory
  readonly holdPolicy: HoldPolicy
  readonly logger: Logger
}
