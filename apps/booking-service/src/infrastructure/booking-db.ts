import type { BookingStatus, CancellationReason } from '../domain/booking.js'
import type { BookingEventType } from '../domain/events.js'

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
  readonly version: number
  readonly updatedAt: Date
}

export interface BookingWriteColumns extends BookingIdentityColumns, BookingStateColumns {
  readonly priceLines: JsonObject
}

/**
 * Baris yang DIBACA. `priceLines` bertipe `unknown`: isi kolom JSON tidak
 * dijamin tipe apa pun, jadi ia diurai dengan skema, tidak dipercaya.
 */
export interface BookingRow extends BookingIdentityColumns, BookingStateColumns {
  readonly priceLines: unknown
}

export interface EventWriteColumns {
  readonly bookingId: string
  readonly sequence: number
  readonly eventType: BookingEventType
  readonly payload: JsonObject
  readonly occurredAt: Date
}

export interface BookingDb {
  readonly booking: {
    findUnique(args: { where: { id: string } }): Promise<BookingRow | null>
    findFirst(args: {
      where: { userId: string; idempotencyKey: string }
    }): Promise<BookingRow | null>
    findMany(args: {
      where: { status: 'HELD'; heldUntil: { lte: Date } }
      orderBy: { heldUntil: 'asc' }
      take: number
    }): Promise<BookingRow[]>
  }
  $transaction<T>(fn: (tx: BookingTx) => Promise<T>): Promise<T>
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
