import { SpanStatusCode, trace, type Attributes, type Span } from '@opentelemetry/api'

/**
 * Span bernama untuk operasi yang layak dilihat sendiri.
 *
 * Instrumentasi otomatis sudah menangkap HTTP, database, dan broker. Yang tidak
 * ditangkapnya adalah batas-batas domain: satu price check ke supplier, satu
 * langkah saga, satu percobaan hold. Justru di situ waktu terbuang dan
 * kegagalan terjadi.
 *
 * Konvensi penamaan: <domain>.<operasi> — misalnya supplier.price_check,
 * booking.saga_step, search.fan_out.
 */

const TRACER_NAME = '@tbe/shared-kernel'

export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return await trace.getTracer(TRACER_NAME).startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span)
      span.setStatus({ code: SpanStatusCode.OK })
      return result
    } catch (error) {
      // Span yang gagal tanpa ditandai akan terlihat berhasil di Jaeger, dan
      // pencarian "trace yang gagal" tidak akan menemukannya.
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : 'galat tidak dikenal',
      })
      if (error instanceof Error) span.recordException(error)
      throw error
    } finally {
      span.end()
    }
  })
}

/** Menambahkan atribut ke span yang sedang aktif, bila ada. */
export function annotateSpan(attributes: Attributes): void {
  trace.getActiveSpan()?.setAttributes(attributes)
}
