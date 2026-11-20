import { fromJson } from '@tbe/money'
import { z } from 'zod'
import type {
  Finding,
  ReconciliationReports,
  ReconciliationSource,
  ReconciliationStore,
  RunReport,
  RunStart,
} from '../application/reconcile.js'
import type { BookingDb, ReconciliationDb } from './booking-db.js'
import { fromRow } from './booking-rows.js'

/**
 * Rekonsiliasi di atas Postgres (Step 28).
 *
 * Kandidat dibaca lewat port `BookingDb` yang sama dengan repository, dan
 * laporannya ditulis lewat port `ReconciliationDb` tersendiri. Keduanya
 * dibuktikan sesuai dengan PrismaClient di prisma-client.ts.
 */

export function createPrismaReconciliationSource(db: BookingDb): ReconciliationSource {
  return {
    async candidates(window, limit) {
      const rows = await db.booking.findMany({
        where: {
          OR: [
            // Menginap belum selesai: kamar yang masih harus ada.
            {
              status: { in: ['CONFIRMED'] },
              checkOut: { gte: window.today },
              updatedAt: { lte: window.until },
            },
            // Uang sudah kembali, atau pengguna membatalkan: kamar yang harus sudah lepas.
            {
              status: { in: ['REFUNDED', 'CANCELLED'] },
              paymentId: { not: null },
              updatedAt: { gte: window.since, lte: window.until },
            },
          ],
        },
        // Yang paling lama tidak diperiksa lebih dulu, dengan urutan pasti:
        // putaran yang terpotong batas berikutnya mulai dari ujung yang sama.
        orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
        take: limit,
      })
      return rows.map(fromRow)
    },

    async supplierTotalOf(bookingId) {
      // Hold TERAKHIR: pemesanan yang hold-nya kedaluwarsa tidak dapat dihold
      // lagi (EXPIRED final), tetapi urutan menurun menjaga jawaban ini benar
      // bila aturan itu kelak berubah.
      const [held] = await db.bookingEvent.findMany({
        where: { bookingId, eventType: 'BookingHeld' },
        orderBy: { sequence: 'desc' },
        take: 1,
      })
      const parsed = heldPayload.safeParse(held?.payload)
      // Peristiwa sebelum Step 28 tidak membawa harga bersih: `undefined`,
      // dan rekonsiliasi tidak membandingkan nilainya.
      return parsed.success ? fromJson(parsed.data.supplierTotal) : undefined
    },
  }
}

/** Bentuknya diperiksa `fromJson`; di sini hanya keberadaan bidangnya. */
const heldPayload = z.object({ supplierTotal: z.unknown() })

export function createPrismaReconciliationStore(db: ReconciliationDb): ReconciliationStore {
  return {
    async begin(request, at): Promise<RunStart> {
      const inserted = await db.reconciliationRun.createMany({
        data: [
          {
            id: request.id,
            day: request.day,
            supplier: request.supplier ?? null,
            startedAt: at,
            finishedAt: null,
          },
        ],
        skipDuplicates: true,
      })
      if (inserted.count === 1) return 'started'

      const existing = await db.reconciliationRun.findUnique({ where: { id: request.id } })
      return existing?.finishedAt === null ? 'resumed' : 'finished'
    },

    async record(finding: Finding) {
      const { runId, bookingId, ...rest } = finding
      await db.reconciliationFinding.upsert({
        where: { runId_bookingId: { runId, bookingId } },
        create: finding,
        update: rest,
      })
    },

    async finish(runId, totals, at) {
      await db.reconciliationRun.update({
        where: { id: runId },
        data: { ...totals, finishedAt: at },
      })
    },
  }
}

export function createPrismaReconciliationReports(db: ReconciliationDb): ReconciliationReports {
  return {
    async recent(runs, findingsPerRun) {
      const recentRuns = await db.reconciliationRun.findMany({
        orderBy: { startedAt: 'desc' },
        take: runs,
      })
      const findings = await db.reconciliationFinding.findMany({
        where: { runId: { in: recentRuns.map((run) => run.id) } },
        orderBy: { recordedAt: 'asc' },
        take: runs * findingsPerRun,
      })

      return recentRuns.map((run): RunReport => ({
        ...run,
        findings: findings
          .filter((finding) => finding.runId === run.id)
          .slice(0, findingsPerRun)
          .map(({ bookingId, supplier, localStatus, kind, detail, flagged, recordedAt }) => ({
            bookingId,
            supplier,
            localStatus,
            kind,
            detail,
            flagged,
            recordedAt,
          })),
      }))
    },
  }
}
