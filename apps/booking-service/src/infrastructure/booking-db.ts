import type { BookingStatus, CancellationReason } from '../domain/booking.js'
import type { BookingEventType } from '../domain/events.js'
import type { SagaStep } from '../domain/saga-definition.js'

/**
 * Bagian klien Prisma yang dipakai repository, dinyatakan sebagai tipe
 * struktural.
 *
 * Repository bergantung pada ini, BUKAN pada `PrismaClient`. Dua alasan:
 *
 * 1. **Palsuan yang meniru transaksi.** Docker mati sejak Step 05; tanpa
 *    Postgres, satu-satunya cara menguji bahwa bookings dan booking_events
 *    ditulis dalam SATU transaksi adalah menjalankan repository sungguhan
 *    terhadap basis data palsuan yang memang punya rollback — lihat
 *    testing/memory-db.ts. `PrismaClient` terlalu besar untuk dipalsukan
 *    dengan jujur.
 * 2. **Jalan tulis hanya lewat transaksi.** Klien akar di tipe ini hanya dapat
 *    MEMBACA. `create`, `updateMany`, dan tabel booking_events hanya ada pada
 *    klien transaksi, jadi menulis peristiwa di luar `$transaction` bahkan
 *    tidak dapat dikompilasi. Yang masih dapat ditulis adalah DUA transaksi
 *    terpisah — dan itu yang ditangkap uji palsuan (suntikan S5).
 *
 * Bahwa `PrismaClient` yang tergenerate benar-benar memenuhi tipe ini
 * dibuktikan compiler di prisma-client.ts, bukan diasumsikan.
 */

/** Nilai JSON yang dapat DITULIS. Kompatibel dengan `InputJsonValue` Prisma. */
export type JsonInput = string | number | boolean | JsonObject | readonly (JsonInput | null)[]

export interface JsonObject {
  readonly [key: string]: JsonInput | null
}

/** Kolom yang tidak berubah sepanjang hidup pemesanan. */
export interface BookingIdentityColumns {
  readonly id: string
  readonly userId: string
  readonly supplierId: string
  readonly propertyId: string
  readonly city: string
  readonly ratePlanRef: string
  readonly checkIn: Date
  readonly checkOut: Date
  readonly guests: number
  readonly leadGuestName: string
  readonly leadGuestEmail: string
  readonly idempotencyKey: string
  readonly createdAt: Date
}

/** Kolom yang berubah pada transisi. */
export interface BookingStateColumns {
  readonly status: BookingStatus
  readonly amountMinor: number
  readonly currency: string
  readonly priceCheck: 'verified' | 'changed' | 'accepted' | null
  readonly quotedAmountMinor: number | null
  readonly quotedCurrency: string | null
  readonly holdRef: string | null
  readonly heldUntil: Date | null
  readonly paymentId: string | null
  readonly supplierRef: string | null
  readonly refundId: string | null
  readonly failureReason: string | null
  readonly cancellation: CancellationReason | null
  readonly reviewReason: string | null
  readonly reviewFrom: BookingStatus | null
  readonly cancelRefundMinor: number | null
  readonly cancelRefundCurrency: string | null
  readonly cancelRefundPercent: number | null
  readonly cancelRequestedAt: Date | null
  readonly cancelStep: 'supplier' | 'refund' | null
  readonly cancelDeadlineAt: Date | null
  readonly version: number
  readonly updatedAt: Date
}

export interface BookingWriteColumns extends BookingIdentityColumns, BookingStateColumns {
  readonly priceLines: JsonObject
  /** `{ tiers: [...] | null }` — lihat schema.prisma. Berubah saat price check (Step 25). */
  readonly refundSchedule: JsonObject
  /** `{ terms: {...} | null }` — lihat schema.prisma. Ditulis sekali, saat dibuat. */
  readonly offerTerms: JsonObject
}

/**
 * Baris yang DIBACA. `priceLines` bertipe `unknown`: isi kolom JSON tidak
 * dijamin tipe apa pun, jadi ia diurai dengan skema, tidak dipercaya.
 */
export interface BookingRow extends BookingIdentityColumns, BookingStateColumns {
  readonly priceLines: unknown
  readonly refundSchedule: unknown
  readonly offerTerms: unknown
}

export interface EventWriteColumns {
  readonly bookingId: string
  readonly sequence: number
  readonly eventType: BookingEventType
  readonly payload: JsonObject
  readonly occurredAt: Date
}

/** Baris saga_states (Step 19). Ditulis dan dibaca dengan bentuk yang sama. */
export interface SagaRow {
  readonly id: string
  readonly bookingId: string
  readonly currentStep: SagaStep
  readonly stepStatus: 'started' | 'waiting' | 'succeeded' | 'failed'
  readonly compensationStatus: 'none' | 'running' | 'completed' | 'failed'
  readonly compensatingStep: SagaStep | null
  readonly attempts: number
  readonly lastError: string | null
  readonly deadlineAt: Date | null
  readonly leasedUntil: Date | null
  readonly version: number
  readonly createdAt: Date
  readonly updatedAt: Date
}

export type SagaUpdateColumns = Omit<SagaRow, 'id' | 'bookingId' | 'createdAt'>

export type OutboxChannel = 'kafka' | 'rabbitmq'

/** Baris outbox yang DITULIS di transaksi bisnis. */
export interface OutboxWriteColumns {
  readonly id: string
  readonly bookingId: string
  readonly channel: OutboxChannel
  readonly messageType: string
  readonly payload: JsonObject
  readonly correlationId: string
  readonly causationId: string | null
  readonly traceparent: string | null
  readonly occurredAt: Date
  readonly createdAt: Date
}

/** Baris outbox yang DIBACA penerbit. `payload` diurai ulang dengan skema kontrak. */
export interface OutboxRow extends Omit<OutboxWriteColumns, 'payload'> {
  readonly payload: unknown
  readonly sequence: bigint
  readonly publishedAt: Date | null
  readonly attempts: number
  readonly lastError: string | null
  readonly rejectedAt: Date | null
}

/** Kemajuan satu pesan outbox: terbit, gagal sementara, atau ditolak kontraknya. */
export type OutboxProgress =
  | { readonly publishedAt: Date }
  | { readonly attempts: number; readonly lastError: string }
  | { readonly attempts: number; readonly lastError: string; readonly rejectedAt: Date }

export interface ConsumedColumns {
  readonly eventId: string
  readonly eventType: string
  readonly bookingId: string
  readonly consumedAt: Date
}

export interface BookingDb {
  readonly booking: {
    findUnique(args: { where: { id: string } }): Promise<BookingRow | null>
    findFirst(args: {
      where: { userId: string; idempotencyKey: string }
    }): Promise<BookingRow | null>
    /**
     * Dua kueri penyapu, masing-masing dilayani indeks gabungannya sendiri:
     * hold yang lewat (Step 17) dan pembatalan yang batas menunggunya lewat
     * (Step 25).
     */
    findMany(args: BookingQuery): Promise<BookingRow[]>
  }
  readonly sagaState: {
    findUnique(args: { where: { bookingId: string } }): Promise<SagaRow | null>
    /**
     * Dua kueri penyapu saga, keduanya dilayani indeks sendiri: saga yang
     * batas menunggunya lewat, dan saga yang sewa prosesnya lewat.
     */
    findMany(args: {
      where: { deadlineAt: { lte: Date } } | { leasedUntil: { lte: Date } }
      orderBy: { deadlineAt: 'asc' } | { leasedUntil: 'asc' }
      take: number
    }): Promise<SagaRow[]>
  }
  $transaction<T>(
    fn: (tx: BookingTx) => Promise<T>,
    options?: { readonly timeout?: number; readonly maxWait?: number },
  ): Promise<T>
}

/**
 * Bentuk kueri daftar: dua penyapu (hold Step 17, pembatalan Step 25) dan
 * daftar pemesanan pengguna (Step 26).
 *
 * SATU bentuk dengan bidang opsional, bukan union atau overload: inferensi
 * generik `findMany` Prisma tidak dapat dicocokkan dengan keduanya, dan bukti
 * kesesuaian di prisma-client.ts akan gagal. Larik ditulis dapat diubah karena
 * tipe Prisma menuntutnya.
 */
export interface BookingQuery {
  readonly where: BookingWhere
  readonly orderBy: BookingOrder | BookingOrder[]
  readonly skip?: number
  readonly take: number
}

export interface BookingWhere {
  readonly status?: 'HELD' | 'CANCELLING'
  readonly heldUntil?: { readonly lte: Date }
  readonly cancelDeadlineAt?: { readonly lte: Date }
  readonly userId?: string
  /** Kelompok daftar pemesanan: keadaan tertentu, dibatasi tanggal keluar bila perlu. */
  readonly OR?: BookingClause[]
}

export interface BookingClause {
  readonly status: { readonly in: BookingStatus[] }
  readonly checkOut?: { readonly gte: Date } | { readonly lt: Date }
}

export interface BookingOrder {
  readonly heldUntil?: 'asc'
  readonly cancelDeadlineAt?: 'asc'
  readonly checkIn?: 'asc' | 'desc'
  readonly updatedAt?: 'desc'
  readonly id?: 'asc'
}

export interface BookingTx {
  readonly booking: {
    create(args: { data: BookingWriteColumns }): Promise<unknown>
    updateMany(args: {
      where: { id: string; version: number }
      data: BookingStateColumns & { readonly priceLines: JsonObject }
    }): Promise<{ count: number }>
  }
  readonly bookingEvent: {
    create(args: { data: EventWriteColumns }): Promise<unknown>
  }
  readonly sagaState: {
    create(args: { data: SagaRow }): Promise<unknown>
    updateMany(args: {
      where: { bookingId: string; version: number }
      data: SagaUpdateColumns
    }): Promise<{ count: number }>
  }
  readonly outboxMessage: {
    create(args: { data: OutboxWriteColumns }): Promise<unknown>
    findMany(args: {
      where: { publishedAt: null; rejectedAt: null }
      orderBy: { sequence: 'asc' }
      take: number
    }): Promise<OutboxRow[]>
    update(args: { where: { id: string }; data: OutboxProgress }): Promise<unknown>
  }
  readonly consumedMessage: {
    create(args: { data: ConsumedColumns }): Promise<unknown>
  }
  /**
   * Hanya untuk kunci penasihat penerbit outbox — lihat prisma-outbox-store.ts.
   * Tidak ada kueri mentah lain di service ini.
   */
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>
}

/** Kode galat Prisma untuk pelanggaran batasan UNIK. */
export const UNIQUE_VIOLATION = 'P2002'

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === UNIQUE_VIOLATION
  )
}
