import { fromColumns, type Money } from '@tbe/money'
import type { Review } from '../domain/booking.js'
import type { BookingRow } from './booking-db.js'

/**
 * Baris pemesanan yang tidak dapat disusun kembali menjadi pemesanan sah.
 *
 * DILEMPAR, tidak dikembalikan sebagai nilai — CONVENTIONS.md bagian 5. Baris
 * yang dirusak bukan kejadian yang dapat diantisipasi pemanggil; itu cacat data
 * yang membutuhkan manusia, dan galatnya menyebut kolom mana yang rusak supaya
 * manusia itu tidak perlu menebak.
 */
export class CorruptBookingRowError extends Error {
  constructor(
    readonly bookingId: string,
    readonly column: string,
    reason: string,
  ) {
    super(`Baris pemesanan ${bookingId} rusak pada ${column}: ${reason}`)
    this.name = 'CorruptBookingRowError'
  }
}

type NullableColumn = {
  [K in keyof BookingRow]: null extends BookingRow[K] ? K : never
}[keyof BookingRow]

/** Pembaca kolom yang WAJIB ada pada keadaan baris ini. */
export class BookingRowReader {
  constructor(private readonly row: BookingRow) {}

  get id(): string {
    return this.row.id
  }

  required<K extends NullableColumn>(column: K): NonNullable<BookingRow[K]> {
    const value = this.row[column]
    // `undefined` tidak pernah datang dari Prisma, tetapi memeriksanya membuat
    // penyempitan ke NonNullable sah tanpa type assertion.
    if (value === null || value === undefined) {
      throw new CorruptBookingRowError(this.row.id, column, `kosong pada status ${this.row.status}`)
    }

    return value
  }

  check<T>(value: T | undefined, column: string): T {
    if (value === undefined) throw new CorruptBookingRowError(this.row.id, column, 'tidak sah')

    return value
  }

  money(amountMinor: number, currency: string, column: string): Money {
    return this.check(fromColumns(amountMinor, currency), column)
  }

  reviewFrom(): Review['from'] {
    const from = this.required('reviewFrom')
    if (from !== 'PAID' && from !== 'FAILED') {
      throw new CorruptBookingRowError(this.row.id, 'reviewFrom', `bukan PAID atau FAILED: ${from}`)
    }

    return from
  }
}
