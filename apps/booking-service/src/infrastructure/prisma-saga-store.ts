import type { SagaStore } from '../application/ports.js'
import type { SagaState } from '../domain/saga-state.js'
import type { BookingDb } from './booking-db.js'
import { fromSagaRow } from './saga-rows.js'
import { commitUnit } from './unit-of-work.js'

/**
 * Keadaan saga di atas Prisma (Step 19).
 *
 * Tulisannya selalu lewat [commitUnit]: tidak ada jalan menyimpan saga di
 * luar transaksi yang juga membawa perubahan pemesanan, perintah outbox, dan
 * catatan pesan terkonsumsi yang menyertainya.
 */
export function createPrismaSagaStore(db: BookingDb): SagaStore {
  return {
    async find(bookingId) {
      const row = await db.sagaState.findUnique({ where: { bookingId } })

      return row === null ? undefined : fromSagaRow(row)
    },

    commit: async (unit) => await commitUnit(db, unit),

    async findDue(now, limit): Promise<readonly SagaState[]> {
      const rows = await db.sagaState.findMany({
        where: { deadlineAt: { lte: now } },
        orderBy: { deadlineAt: 'asc' },
        take: limit,
      })

      return rows.map(fromSagaRow)
    },

    async findLeaseExpired(now, limit): Promise<readonly SagaState[]> {
      const rows = await db.sagaState.findMany({
        where: { leasedUntil: { lte: now } },
        orderBy: { leasedUntil: 'asc' },
        take: limit,
      })

      return rows.map(fromSagaRow)
    },
  }
}
