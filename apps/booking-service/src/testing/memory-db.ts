import { randomUUID } from 'node:crypto'
import type {
  BookingDb,
  BookingRow,
  BookingTx,
  BookingWriteColumns,
  EventWriteColumns,
} from '../infrastructure/booking-db.js'
import { UNIQUE_VIOLATION } from '../infrastructure/booking-db.js'
import {
  PrismaLikeError,
  advisoryLock,
  consumedTx,
  outboxTx,
  sagaTx,
  sagasDue,
  type SagaFailpoint,
  type SagaTables,
} from './memory-saga-tables.js'

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
 * Step 19 menambah tiga tabel — saga_states, outbox, consumed_messages — lewat
 * memory-saga-tables.ts, dengan sifat yang sama: ikut transaksi, UNIK, dan
 * kunci asing ke bookings.
 *
 * Yang TIDAK ditiru: batasan CHECK, trigger append-only, dan PERSAINGAN kunci
 * penasihat penerbit outbox. Ketiganya dibuktikan terhadap Postgres sungguhan
 * di tests/integration.
 */

interface Tables extends SagaTables {
  events: StoredEvent[]
}

export interface StoredEvent extends EventWriteColumns {
  readonly id: string
}

/** Tulisan yang dapat diperintah gagal, untuk menyuntikkan kegagalan di tengah transaksi. */
export type Failpoint =
  'booking.create' | 'booking.updateMany' | 'bookingEvent.create' | SagaFailpoint

export interface MemoryBookingDb extends BookingDb {
  /** Tabel yang SUDAH di-commit. Tulisan transaksi yang dibatalkan tidak pernah terlihat di sini. */
  readonly committed: () => Readonly<Tables>
  /** Tulisan berikutnya pada titik ini melempar, satu kali. */
  failNext(point: Failpoint): void
  /** Banyak transaksi yang dimulai — penulisan di luar transaksi tidak mungkin, lihat BookingDb. */
  readonly transactions: () => number
  /** Kunci penasihat penerbit outbox dianggap dipegang instance lain. */
  holdOutboxLockElsewhere(held: boolean): void
}

function emptyTables(): Tables {
  return {
    bookings: new Map(),
    events: [],
    sagas: new Map(),
    outbox: [],
    consumed: new Map(),
    sequence: new Map(),
  }
}

function copy(tables: Tables): Tables {
  return structuredClone(tables)
}

function txOver(
  tables: Tables,
  trip: (point: Failpoint) => void,
  lockedElsewhere: () => boolean,
): BookingTx {
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
    sagaState: sagaTx(tables, trip),
    outboxMessage: outboxTx(tables, trip),
    consumedMessage: consumedTx(tables, trip),
    $queryRaw: advisoryLock(lockedElsewhere),
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

/** Pembaca di luar transaksi: selalu melihat tabel yang SUDAH di-commit. */
function readersOver(committed: () => Tables): Pick<BookingDb, 'booking' | 'sagaState'> {
  return {
    booking: {
      findUnique: async ({ where }) => {
        await Promise.resolve()
        return structuredClone(committed().bookings.get(where.id)) ?? null
      },
      findMany: async ({ where, take }) => {
        await Promise.resolve()
        return structuredClone(dueRows(committed(), where.heldUntil.lte, take))
      },
      findFirst: async ({ where }) => {
        await Promise.resolve()
        const found = [...committed().bookings.values()].find(
          (row) => row.userId === where.userId && row.idempotencyKey === where.idempotencyKey,
        )
        return structuredClone(found) ?? null
      },
    },
    sagaState: {
      findUnique: async ({ where }) => {
        await Promise.resolve()
        return structuredClone(committed().sagas.get(where.bookingId)) ?? null
      },
      findMany: async ({ where, take }) => {
        await Promise.resolve()
        return structuredClone(sagasDue(committed(), where, take))
      },
    },
  }
}

interface Options {
  /** false meniru basis data TANPA rollback: setiap tulisan langsung permanen. */
  readonly atomic: boolean
}

function build(options: Options): MemoryBookingDb {
  let committed: Tables = emptyTables()
  const armed = new Set<Failpoint>()
  let transactions = 0
  let outboxLockHeld = false
  const lockedElsewhere = (): boolean => outboxLockHeld
  let queue: Promise<unknown> = Promise.resolve()

  const trip = (point: Failpoint): void => {
    if (!armed.delete(point)) return
    throw new Error(`kegagalan disuntikkan pada ${point}`)
  }

  async function run<T>(fn: (tx: BookingTx) => Promise<T>): Promise<T> {
    transactions += 1
    if (!options.atomic) return await fn(txOver(committed, trip, lockedElsewhere))

    const working = copy(committed)
    const result = await fn(txOver(working, trip, lockedElsewhere))
    committed = working

    return result
  }

  return {
    committed: () => committed,
    transactions: () => transactions,
    failNext: (point) => {
      armed.add(point)
    },
    holdOutboxLockElsewhere: (held) => {
      outboxLockHeld = held
    },
    ...readersOver(() => committed),
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
