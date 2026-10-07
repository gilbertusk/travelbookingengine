import type { Logger } from '@tbe/shared-kernel'
import type { VoucherContent } from '../domain/voucher-content.js'
import type { Voucher, VoucherProperty, VoucherSource } from '../domain/voucher.js'

/**
 * Port voucher-service. Application bergantung pada bentuk-bentuk ini, bukan
 * pada Prisma, MinIO, PDFKit, atau undici — CONVENTIONS.md bagian 1.
 *
 * Aturan galat yang dipegang setiap adapter: "tidak ada" dijawab sebagai NILAI
 * (`undefined`, `not_found`), sedangkan "tidak dapat ditanyai" DILEMPAR
 * sebagai galat 5xx. Pembedaan itu yang membuat consumer mencoba lagi ketika
 * booking-service sedang mati, tetapi tidak ketika pemesanannya memang tidak
 * ada.
 */

export type SourceLookup =
  { readonly kind: 'found'; readonly source: VoucherSource } | { readonly kind: 'not_found' }

export interface BookingDirectory {
  voucherSource(bookingId: string): Promise<SourceLookup>
}

export interface PropertyDirectory {
  /** `undefined` bila pengenal supplier itu belum terpetakan ke katalog. */
  bySupplier(supplier: string, supplierPropertyId: string): Promise<VoucherProperty | undefined>
}

export type InsertOutcome =
  | { readonly kind: 'inserted' }
  /** Batasan UNIK pada bookingId menolak baris kedua; ini voucher yang menang. */
  | { readonly kind: 'exists'; readonly existing: Voucher }

export interface VoucherRepository {
  findByBookingId(bookingId: string): Promise<Voucher | undefined>
  insert(voucher: Voucher): Promise<InsertOutcome>
}

export interface VoucherStorage {
  put(objectKey: string, pdf: Uint8Array): Promise<void>
  remove(objectKey: string): Promise<void>
  /** URL bertanda tangan untuk mengunduh, berlaku `ttlSeconds` detik. */
  signedUrl(objectKey: string, ttlSeconds: number): Promise<string>
}

export interface VoucherRenderer {
  render(content: VoucherContent): Promise<Uint8Array>
}

export interface VoucherEvents {
  /**
   * Menerbitkan `voucher.issued`. eventId-nya adalah id voucher, sehingga
   * penerbitan ulang untuk voucher yang sama dapat dikenali sebagai duplikat
   * oleh pembacanya.
   */
  issued(voucher: Voucher, latencyMs: number): Promise<void>
}

export interface IssueMetrics {
  /** Selisih konfirmasi sampai voucher terbit, dalam detik (M7). */
  observeIssueLatency(seconds: number): void
}

export interface Clock {
  now(): Date
}

export interface IdFactory {
  next(): string
}

/** Token acak untuk kunci objek. Lihat domain/object-key.ts. */
export interface TokenFactory {
  next(): string
}

export interface VoucherDeps {
  readonly bookings: BookingDirectory
  readonly properties: PropertyDirectory
  readonly vouchers: VoucherRepository
  readonly storage: VoucherStorage
  readonly renderer: VoucherRenderer
  readonly events: VoucherEvents
  readonly metrics: IssueMetrics
  readonly clock: Clock
  readonly ids: IdFactory
  readonly tokens: TokenFactory
  readonly logger: Logger
}
