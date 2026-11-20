import { summarize, type AnalyticsSummary } from '../domain/summary.js'
import type { AnalyticsStore, DayRange } from './ports.js'

/** Laporan untuk panel operator: penghitung dalam rentang hari, diringkas di domain. */
export async function analyticsSummary(
  deps: { readonly store: AnalyticsStore },
  range: DayRange,
  top: number,
): Promise<{ readonly range: DayRange; readonly summary: AnalyticsSummary }> {
  const rows = await deps.store.counters(range)
  return { range, summary: summarize(rows, top) }
}
