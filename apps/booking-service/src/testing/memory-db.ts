import { randomUUID } from 'node:crypto'
import type {
  BookingDb,
  BookingRow,
  BookingTx,
  BookingWriteColumns,
  EventWriteColumns,
} from '../infrastructure/booking-db.js'
import { UNIQUE_VIOLATION } from '../infrastructure/booking-db.js'

/**
 * Basis data palsuan untuk repository pemesanan.
 *
 * Docker mati sejak Step 05, jadi tidak ada Postgres. Palsuan ini tidak sekadar
 * mencatat panggilan — ia MENIRU tiga sifat Postgres yang diandalkan
 * repository, karena uji terhadap palsuan yang tidak punya sifat itu akan lulus
 * untuk kode yang salah:
 *
 * 1. **Transaksi dengan rollback.** `$transaction` bekerja pada salinan tabel;
 *    salinan menggantikan tabel hanya bila fungsi transaksinya selesai tanpa
 *    melempar. Galat di tengah membuang SELURUH tulisan transaksi itu.
 * 2. **Batasan UNIK dan kunci asing.** `(user_id, idempotency_key)`,
 *    `(booking_id, sequence)`, primary key, dan booking_events → bookings.
 *    Pelanggarannya dilempar dengan kode Prisma yang sama (`P2002`, `P2003`).
 * 3. **Penulis yang berebut baris yang sama diserialkan.** Transaksi berjalan
 *    satu per satu, meniru penulis kedua yang menunggu kunci baris di
 *    Postgres lalu melihat hasil penulis pertama.
 *
 * Untuk sifat pertama ada palsuan TANDINGAN, [autocommitBookingDb]: sama
 * persis tetapi tanpa rollback. Uji atomisitas yang sama WAJIB gagal padanya —
 * itu yang membuktikan uji atomisitas tidak hampa.
 *
 * Yang TIDAK ditiru: batasan CHECK dan trigger append-only di migrasi. Keduanya
 * hanya dapat dibuktikan terhadap Postgres sungguhan (README, bagian perintah
 * yang belum dijalankan).
 */

interface Tables {
  bookings: Map<string, BookingRow>
  events: StoredEvent[]
}

export interface StoredEvent extends EventWriteColumns {
  readonly id: string
}

/** Tulisan yang dapat diperintah gagal, untuk menyuntikkan kegagalan di tengah transaksi. */
export type Failpoint = 'booking.create' | 'booking.updateMany' | 'bookingEvent.create'

export interface MemoryBookingDb extends BookingDb {
  /** Tabel yang SUDAH di-commit. Tulisan transaksi yang dibatalkan tidak pernah terlihat di sini. */
  readonly committed: () => Readonly<Tables>
  /** Tulisan berikutnya pada titik ini melempar, satu kali. */
  failNext(point: Failpoint): void
  /** Banyak transaksi yang dimulai — penulisan di luar transaksi tidak mungkin, lihat BookingDb. */
  readonly transactions: () => number
}

class PrismaLikeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

function copy(tables: Tables): Tables {
  return {
    bookings: new Map(structuredClone([...tables.bookings])),
    events: structuredClone(tables.events),
  }
}

function txOver(tables: Tables, trip: (point: Failpoint) => void): BookingTx {
  return {
    booking: {
      create: async ({ data }) => {
        trip('booking.create')
        insertBooking(tables, data)
        await Promise.resolve()
      },
      updateMany: async ({ where, data }) => {
        trip('booking.updateMany')
        const row = tables.bookings.get(where.id)
        await Promise.resolve()
        if (row?.version !== where.version) return { count: 0 }

        // Tidak dapat undefined di sini: versi yang cocok berarti barisnya ada.
        tables.bookings.set(where.id, { ...row, ...data })
        return { count: 1 }
      },
    },
    bookingEvent: {
      create: async ({ data }) => {
        trip('bookingEvent.create')
        insertEvent(tables, data)
        await Promise.resolve()
      },
    },
  }
}

function insertBooking(tables: Tables, data: BookingWriteColumns): void {
  if (tables.bookings.has(data.id)) throw new PrismaLikeError(UNIQUE_VIOLATION, 'bookings_pkey')

  const clash = [...tables.bookings.values()].some(
    (row) => row.userId === data.userId && row.idempotencyKey === data.idempotencyKey,
  )
  if (clash) throw new PrismaLikeError(UNIQUE_VIOLATION, 'bookings_user_id_idempotency_key_key')

  tables.bookings.set(data.id, structuredClone(data))
}

function insertEvent(tables: Tables, data: EventWriteColumns): void {
  if (!tables.bookings.has(data.bookingId)) {
    throw new PrismaLikeError('P2003', 'booking_events_booking_id_fkey')
  }

  const clash = tables.events.some(
    (row) => row.bookingId === data.bookingId && row.sequence === data.sequence,
  )
  if (clash) throw new PrismaLikeError(UNIQUE_VIOLATION, 'booking_events_booking_id_sequence_key')

  tables.events.push({ id: randomUUID(), ...structuredClone(data) })
}

/** Baris HELD yang batas waktunya sudah lewat, meniru kueri penyapu. */
function dueRows(tables: Tables, now: Date, take: number): BookingRow[] {
  return [...tables.bookings.values()]
    .filter(
      (row) =>
        row.status === 'HELD' && row.heldUntil !== null && row.heldUntil.getTime() <= now.getTime(),
    )
    .sort((a, b) => (a.heldUntil?.getTime() ?? 0) - (b.heldUntil?.getTime() ?? 0))
    .slice(0, take)
}

interface Options {
  /** false meniru basis data TANPA rollback: setiap tulisan langsung permanen. */
  readonly atomic: boolean
}

function build(options: Options): MemoryBookingDb {
  let committed: Tables = { bookings: new Map(), events: [] }
  const armed = new Set<Failpoint>()
  let transactions = 0
  let queue: Promise<unknown> = Promise.resolve()

  const trip = (point: Failpoint): void => {
    if (!armed.delete(point)) return
    throw new Error(`kegagalan disuntikkan pada ${point}`)
  }

  async function run<T>(fn: (tx: BookingTx) => Promise<T>): Promise<T> {
    transactions += 1
    if (!options.atomic) return await fn(txOver(committed, trip))

    const working = copy(committed)
    const result = await fn(txOver(working, trip))
    committed = working

    return result
  }

  return {
    committed: () => committed,
    transactions: () => transactions,
    failNext: (point) => {
      armed.add(point)
    },
    booking: {
      findUnique: async ({ where }) => {
        await Promise.resolve()
        return structuredClone(committed.bookings.get(where.id)) ?? null
      },
      findMany: async ({ where, take }) => {
        await Promise.resolve()
        return structuredClone(dueRows(committed, where.heldUntil.lte, take))
      },
      findFirst: async ({ where }) => {
        await Promise.resolve()
        const found = [...committed.bookings.values()].find(
          (row) => row.userId === where.userId && row.idempotencyKey === where.idempotencyKey,
        )
        return structuredClone(found) ?? null
      },
    },
    $transaction: async <T>(fn: (tx: BookingTx) => Promise<T>): Promise<T> => {
      // Antrean: transaksi berikutnya menunggu yang sebelumnya selesai,
      // berhasil ATAU gagal.
      const result = queue.then(async () => await run(fn))
      queue = result.catch(() => undefined)

      return await result
    },
  }
}

/** Basis data dengan transaksi sungguhan: semua tulisan satu transaksi, atau tidak satu pun. */
export function memoryBookingDb(): MemoryBookingDb {
  return build({ atomic: true })
}

/**
 * Palsuan TANDINGAN: setiap tulisan langsung permanen, tanpa rollback.
 *
 * Sengaja salah. Inilah perilaku kode yang menulis bookings dan booking_events
 * sebagai dua pernyataan terpisah dengan autocommit — dan pada satu proses
 * tanpa kegagalan, ia terlihat bekerja sempurna.
 */
export function autocommitBookingDb(): MemoryBookingDb {
  return build({ atomic: false })
}
