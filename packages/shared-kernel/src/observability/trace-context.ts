import { trace } from '@opentelemetry/api'

/**
 * Pengenal trace yang sedang aktif.
 *
 * Modul ini sengaja dibuat sekecil mungkin dan hanya bergantung pada
 * @opentelemetry/api, supaya logger dapat memakainya tanpa menarik seluruh SDK.
 * Tanpa pemisahan itu, setiap service yang hanya butuh logger ikut memuat
 * eksportir dan instrumentasi yang tidak dipakainya.
 */

export interface TraceIds {
  readonly traceId?: string
  readonly spanId?: string
}

export function currentTraceIds(): TraceIds {
  const span = trace.getActiveSpan()
  if (span === undefined) return {}

  const context = span.spanContext()

  // Span yang tidak terekam tetap punya pengenal, tetapi pengenalnya nol
  // dan hanya akan mengotori log dengan nilai yang tidak menunjuk apa pun.
  if (context.traceId === '00000000000000000000000000000000') return {}

  return { traceId: context.traceId, spanId: context.spanId }
}
