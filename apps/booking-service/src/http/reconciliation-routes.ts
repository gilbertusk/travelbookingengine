import { requireOperator, success, validate } from '@tbe/shared-kernel'
import { Router } from 'express'
import { z } from 'zod'
import type { ReconciliationReports, RunReport } from '../application/reconcile.js'
import { SUPPLIER_CODES, type SupplierCode } from '../domain/booking.js'

/**
 * Laporan rekonsiliasi di panel operator (Step 28, FR-33).
 *
 * Dua rute:
 *
 * - `GET  /ops/bookings/reconciliation` — putaran terakhir beserta temuannya.
 * - `POST /ops/bookings/reconciliation/run` — minta satu putaran SEKARANG.
 *   Perintahnya lewat antrean yang sama dengan penjadwal, bukan dijalankan di
 *   dalam permintaan HTTP: putaran memanggil supplier satu per satu dan dapat
 *   berjalan beberapa menit, dan ia harus mendapat percobaan ulang dan dead
 *   letter yang sama dengan putaran terjadwal. Jawabannya 202 dengan
 *   pengenal putaran, yang muncul di daftar begitu consumer memulainya.
 *
 * Dipasang SEBELUM router operator lain: `/ops/bookings/:id` akan membaca
 * `reconciliation` sebagai pengenal pemesanan dan menolaknya sebagai bukan UUID.
 */

export interface ReconciliationOps {
  readonly reports: ReconciliationReports
  /** Mengirim `reconciliation.run`; mengembalikan pengenal putarannya. */
  request(supplier: SupplierCode | undefined): Promise<string>
}

const reportQuery = validate(
  z.object({ runs: z.coerce.number().int().min(1).max(50).default(10) }),
  'query',
)

const runBody = validate(z.object({ supplier: z.enum(SUPPLIER_CODES).optional() }).strict(), 'body')

/** Temuan per putaran yang dikirim ke panel. Putaran dengan lebih banyak temuan menyebut jumlahnya. */
export const FINDINGS_PER_RUN = 200

export function createReconciliationRouter(ops: ReconciliationOps): Router {
  const router = Router()

  router.use('/ops/bookings/reconciliation', requireOperator)
  router.get('/ops/bookings/reconciliation', reportQuery, (_req, res, next) => {
    void ops.reports.recent(reportQuery.value(res).runs, FINDINGS_PER_RUN).then((runs) => {
      res.json(success(runs.map(runView)))
    }, next)
  })
  router.post('/ops/bookings/reconciliation/run', runBody, (_req, res, next) => {
    void ops.request(runBody.value(res).supplier).then((runId) => {
      res.status(202).json(success({ runId }))
    }, next)
  })

  return router
}

function runView(run: RunReport) {
  return {
    id: run.id,
    day: run.day,
    supplier: run.supplier,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    checked: run.checked,
    matched: run.matched,
    mismatched: run.mismatched,
    unverified: run.unverified,
    flagged: run.flagged,
    findings: run.findings.map((finding) => ({
      ...finding,
      recordedAt: finding.recordedAt.toISOString(),
    })),
  }
}
