import { ValidationError, requireOperator, success, validate } from '@tbe/shared-kernel'
import { Router } from 'express'
import { z } from 'zod'
import type { AnalyticsStore, Clock, DayRange } from '../application/ports.js'
import { analyticsSummary } from '../application/summary.js'

/**
 * Laporan analitik untuk panel operator (Step 27). Satu-satunya rute bisnis
 * service ini, dan ia di balik `requireOperator` pada awalannya.
 */

const DAY_MS = 86_400_000
/** Satu tahun. Lebih panjang dari itu melampaui retensi topik terlama (90 hari) pun tidak berarti. */
const MAX_RANGE_DAYS = 366

const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'harus YYYY-MM-DD')

const summaryQuery = validate(
  z.object({
    from: localDate.optional(),
    to: localDate.optional(),
    top: z.coerce.number().int().min(1).max(50).default(10),
  }),
  'query',
)

export interface OpsRouteOptions {
  readonly store: AnalyticsStore
  readonly clock: Clock
  readonly defaultDays: number
}

export function createOpsRouter(options: OpsRouteOptions): Router {
  const router = Router()

  router.use('/ops/analytics', requireOperator)
  router.get('/ops/analytics/summary', summaryQuery, (_req, res, next) => {
    const query = summaryQuery.value(res)
    const range = rangeOf(query, options.clock.now(), options.defaultDays)
    if (range instanceof ValidationError) {
      next(range)
      return
    }

    void analyticsSummary(options, range, query.top).then((report) => {
      res.json(success(report))
    }, next)
  })

  return router
}

/**
 * Rentang hari UTC, inklusif. Bawaan: `defaultDays` hari terakhir sampai hari
 * ini. Tanggal yang tidak ada di kalender (2026-02-30) ditolak — `Date`
 * diam-diam menggesernya ke Maret.
 */
export function rangeOf(
  query: { readonly from?: string | undefined; readonly to?: string | undefined },
  now: Date,
  defaultDays: number,
): DayRange | ValidationError {
  const to = query.to ?? now.toISOString().slice(0, 10)
  const from = query.from ?? shiftDays(to, -(defaultDays - 1))

  if (!isCalendarDate(from) || !isCalendarDate(to)) {
    return new ValidationError('tanggal tidak ada di kalender')
  }
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS + 1
  if (days < 1) return new ValidationError('`from` setelah `to`')
  if (days > MAX_RANGE_DAYS) {
    return new ValidationError(`rentang paling panjang ${String(MAX_RANGE_DAYS)} hari`)
  }

  return { from, to }
}

function shiftDays(day: string, delta: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + delta * DAY_MS).toISOString().slice(0, 10)
}

function isCalendarDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}
