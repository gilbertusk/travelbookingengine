import type { AuditEntry, ReviewReader } from '../application/review-queue.js'
import type { BookingDb } from './booking-db.js'
import { fromRow } from './booking-rows.js'

/**
 * Pembacaan antrean tinjauan (Step 27) di atas port `BookingDb` yang sama
 * dengan repository — kesesuaiannya dengan PrismaClient yang dihasilkan
 * dibuktikan di prisma-client.ts, dan palsuan memori menirunya.
 *
 * NEEDS_REVIEW dilayani awalan indeks `(status, held_until)`; urutan
 * `updated_at` diurutkan di atas hasil saringan status, yang kecil.
 */
export function createPrismaReviewReader(db: BookingDb): ReviewReader {
  return {
    async needingReview(limit) {
      const rows = await db.booking.findMany({
        where: { status: 'NEEDS_REVIEW' },
        orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
        take: limit,
      })
      return rows.map(fromRow)
    },

    async auditTrail(bookingId, limit) {
      const rows = await db.bookingEvent.findMany({
        where: { bookingId },
        orderBy: { sequence: 'asc' },
        take: limit,
      })
      return rows.map((row): AuditEntry => ({
        sequence: row.sequence,
        type: row.eventType,
        occurredAt: row.occurredAt,
        payload: row.payload,
      }))
    },
  }
}
