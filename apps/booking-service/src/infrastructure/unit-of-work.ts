import { randomUUID } from 'node:crypto'
import type { CommitOutcome, SagaUnit } from '../application/ports.js'
import type { BookingChange } from '../domain/events.js'
import type { SagaState } from '../domain/saga-state.js'
import { isUniqueViolation, type BookingDb, type BookingTx } from './booking-db.js'
import { toEventRow, toStateColumns } from './booking-rows.js'
import { commandRow, eventRow } from './outbox-rows.js'
import { toSagaColumns, toSagaRow } from './saga-rows.js'

/**
 * Satu unit kerja saga dalam SATU transaksi Postgres.
 *
 * Urutan di dalam transaksi dipilih, bukan kebetulan:
 *
 * 1. **Catatan pesan terkonsumsi lebih dulu.** Duplikat ditolak kunci primernya
 *    sebelum apa pun ditulis — dan penolakan itu membatalkan transaksinya.
 * 2. **Pemesanan, lalu jejaknya, lalu outbox peristiwanya.** Pemeriksaan versi
 *    pemesanan harus menang sebelum ada yang ditulis ke jejak. Baris
 *    pemesanan yang terkunci juga yang menyerialkan transaksi pemesanan yang
 *    sama, dan itulah yang membuat urutan outbox per pemesanan sama dengan
 *    urutan commit.
 * 3. **Saga, lalu perintah.**
 *
 * Kegagalan pemeriksaan versi DILEMPAR di dalam transaksi, bukan dikembalikan:
 * mengembalikan nilai dari fungsi transaksi berarti COMMIT, dan tulisan yang
 * sudah terjadi sebelum pemeriksaan — catatan pesan terkonsumsi — akan ikut
 * tersimpan untuk efek yang tidak pernah terjadi.
 */

class StaleWrite extends Error {}
class AlreadyConsumed extends Error {}

/** Transisi pemesanan beserta jejak dan padanan Kafka-nya. Melempar StaleWrite. */
export async function writeTransition(
  tx: BookingTx,
  change: BookingChange,
  causationId: string | undefined,
): Promise<void> {
  const { booking, event } = change
  const { count } = await tx.booking.updateMany({
    where: { id: booking.id, version: booking.version - 1 },
    data: toStateColumns(booking),
  })
  if (count === 0) throw new StaleWrite()

  await tx.bookingEvent.create({ data: toEventRow(event) })
  await writeEventOutbox(tx, change, causationId)
}

/** Padanan Kafka peristiwa domain, bila ada, ke outbox. */
export async function writeEventOutbox(
  tx: BookingTx,
  change: BookingChange,
  causationId: string | undefined,
): Promise<void> {
  const row = eventRow(change.event, { createdAt: change.event.occurredAt, causationId })
  if (row !== undefined) await tx.outboxMessage.create({ data: row })
}

async function writeSaga(tx: BookingTx, saga: SagaState): Promise<void> {
  if (saga.version === 1) {
    try {
      await tx.sagaState.create({ data: toSagaRow(saga, randomUUID()) })
    } catch (error) {
      // Saga untuk pemesanan ini sudah dibuat pihak lain lebih dulu.
      if (isUniqueViolation(error)) throw new StaleWrite()
      throw error
    }
    return
  }

  const { count } = await tx.sagaState.updateMany({
    where: { bookingId: saga.bookingId, version: saga.version - 1 },
    data: toSagaColumns(saga),
  })
  if (count === 0) throw new StaleWrite()
}

async function writeUnit(tx: BookingTx, unit: SagaUnit): Promise<void> {
  const causationId = unit.consumed?.eventId

  if (unit.consumed !== undefined) {
    try {
      await tx.consumedMessage.create({
        data: { ...unit.consumed, bookingId: unit.bookingId, consumedAt: unit.at },
      })
    } catch (error) {
      if (isUniqueViolation(error)) throw new AlreadyConsumed()
      throw error
    }
  }

  if (unit.change !== undefined) await writeTransition(tx, unit.change, causationId)
  if (unit.saga !== undefined) await writeSaga(tx, unit.saga)

  const meta = { bookingId: unit.bookingId, occurredAt: unit.at, createdAt: unit.at, causationId }
  for (const command of unit.commands ?? []) {
    await tx.outboxMessage.create({ data: commandRow(command, meta) })
  }
}

export async function commitUnit(db: BookingDb, unit: SagaUnit): Promise<CommitOutcome> {
  try {
    await db.$transaction(async (tx) => {
      await writeUnit(tx, unit)
    })
    return 'committed'
  } catch (error) {
    if (error instanceof StaleWrite) return 'stale'
    if (error instanceof AlreadyConsumed) return 'already_consumed'
    throw error
  }
}

/** Untuk repository pemesanan: transisi saja, tanpa saga. */
export async function commitTransition(
  db: BookingDb,
  change: BookingChange,
): Promise<'saved' | 'stale'> {
  const outcome = await commitUnit(db, {
    bookingId: change.booking.id,
    at: change.event.occurredAt,
    change,
  })

  return outcome === 'committed' ? 'saved' : 'stale'
}
