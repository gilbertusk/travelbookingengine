import type {
  BookingRow,
  BookingTx,
  ConsumedColumns,
  OutboxRow,
  OutboxWriteColumns,
  SagaRow,
} from '../infrastructure/booking-db.js'
import { UNIQUE_VIOLATION } from '../infrastructure/booking-db.js'

/**
 * Tiga tabel Step 19 di basis data palsuan: saga_states, outbox, dan
 * consumed_messages. Dipisah dari memory-db.ts hanya karena ukuran berkas;
 * sifat yang ditiru sama — ikut transaksi, UNIK, kunci asing.
 */

export interface SagaTables {
  bookings: Map<string, BookingRow>
  sagas: Map<string, SagaRow>
  outbox: OutboxRow[]
  consumed: Map<string, ConsumedColumns>
  /** Urutan outbox berikutnya, meniru BIGSERIAL. */
  readonly sequence: Map<'outbox', bigint>
}

export type SagaFailpoint =
  | 'sagaState.create'
  | 'sagaState.updateMany'
  | 'outboxMessage.create'
  | 'outboxMessage.update'
  | 'consumedMessage.create'

export class PrismaLikeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

type Trip = (point: SagaFailpoint) => void

export function sagaTx(tables: SagaTables, trip: Trip): BookingTx['sagaState'] {
  return {
    create: async ({ data }) => {
      trip('sagaState.create')
      await Promise.resolve()
      if (!tables.bookings.has(data.bookingId)) {
        throw new PrismaLikeError('P2003', 'saga_states_booking_id_fkey')
      }
      if (tables.sagas.has(data.bookingId)) {
        throw new PrismaLikeError(UNIQUE_VIOLATION, 'saga_states_booking_id_key')
      }
      tables.sagas.set(data.bookingId, structuredClone(data))
    },
    updateMany: async ({ where, data }) => {
      trip('sagaState.updateMany')
      await Promise.resolve()
      const row = tables.sagas.get(where.bookingId)
      if (row?.version !== where.version) return { count: 0 }

      tables.sagas.set(where.bookingId, { ...row, ...structuredClone(data) })
      return { count: 1 }
    },
  }
}

export function outboxTx(tables: SagaTables, trip: Trip): BookingTx['outboxMessage'] {
  return {
    create: async ({ data }) => {
      trip('outboxMessage.create')
      await Promise.resolve()
      insertOutbox(tables, data)
    },
    findMany: async ({ take }) => {
      await Promise.resolve()
      return structuredClone(
        tables.outbox
          .filter((row) => row.publishedAt === null && row.rejectedAt === null)
          .slice(0, take),
      )
    },
    update: async ({ where, data }) => {
      trip('outboxMessage.update')
      await Promise.resolve()
      const index = tables.outbox.findIndex((row) => row.id === where.id)
      const row = tables.outbox[index]
      if (row === undefined) throw new PrismaLikeError('P2025', 'outbox tidak ditemukan')
      tables.outbox.splice(index, 1, { ...row, ...structuredClone(data) })
    },
  }
}

export function consumedTx(tables: SagaTables, trip: Trip): BookingTx['consumedMessage'] {
  return {
    create: async ({ data }) => {
      trip('consumedMessage.create')
      await Promise.resolve()
      if (tables.consumed.has(data.eventId)) {
        throw new PrismaLikeError(UNIQUE_VIOLATION, 'consumed_messages_pkey')
      }
      tables.consumed.set(data.eventId, structuredClone(data))
    },
  }
}

/**
 * Kunci penasihat penerbit outbox. Transaksi palsuan berjalan satu per satu,
 * jadi dalam palsuan ini kunci hanya "dipegang pihak lain" bila uji
 * menyatakannya. PERSAINGANNYA yang sungguhan diuji terhadap Postgres di
 * tests/integration/outbox-relay.test.ts.
 */
export function advisoryLock(heldElsewhere: () => boolean) {
  return async <T>(query: TemplateStringsArray): Promise<T> => {
    await Promise.resolve()
    const sql = query.join('?')
    if (!sql.includes('pg_try_advisory_xact_lock')) {
      throw new Error(`kueri mentah tidak dikenal palsuan: ${sql}`)
    }

    // Bentuk jawaban Postgres untuk kueri itu. T ditentukan pemanggil, dan
    // pemanggilnya — outbox-relay.ts — memeriksa bentuk ini tanpa percaya tipe.
    return [{ locked: !heldElsewhere() }] as T
  }
}

function insertOutbox(tables: SagaTables, data: OutboxWriteColumns): void {
  if (!tables.bookings.has(data.bookingId)) {
    throw new PrismaLikeError('P2003', 'outbox_booking_id_fkey')
  }
  if (tables.outbox.some((row) => row.id === data.id)) {
    throw new PrismaLikeError(UNIQUE_VIOLATION, 'outbox_pkey')
  }

  const sequence = tables.sequence.get('outbox') ?? 1n
  tables.outbox.push({
    ...structuredClone(data),
    sequence,
    publishedAt: null,
    attempts: 0,
    lastError: null,
    rejectedAt: null,
  })
  tables.sequence.set('outbox', sequence + 1n)
}

/** Meniru dua kueri penyapu saga: batas menunggu, atau sewa proses, yang sudah lewat. */
export function sagasDue(
  tables: SagaTables,
  where: { deadlineAt: { lte: Date } } | { leasedUntil: { lte: Date } },
  take: number,
): SagaRow[] {
  const byDeadline = 'deadlineAt' in where
  const at = (row: SagaRow): Date | null => (byDeadline ? row.deadlineAt : row.leasedUntil)
  const limit = byDeadline ? where.deadlineAt.lte : where.leasedUntil.lte

  return [...tables.sagas.values()]
    .filter((row) => {
      const due = at(row)
      return due !== null && due.getTime() <= limit.getTime()
    })
    .sort((a, b) => (at(a)?.getTime() ?? 0) - (at(b)?.getTime() ?? 0))
    .slice(0, take)
}
