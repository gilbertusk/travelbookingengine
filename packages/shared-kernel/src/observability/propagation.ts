import { context, trace } from '@opentelemetry/api'
import { W3CTraceContextPropagator } from '@opentelemetry/core'

/**
 * Perambatan konteks trace lewat amplop pesan.
 *
 * Instrumentasi otomatis merambatkan trace lewat header HTTP tanpa diminta,
 * tetapi berhenti di situ. Begitu alur berpindah ke Kafka atau RabbitMQ,
 * trace terputus — dan itu terjadi tepat di titik paling menarik, ketika
 * pemesanan masuk ke saga asinkron.
 *
 * Dua fungsi di bawah yang menyambungnya kembali: satu menaruh traceparent ke
 * amplop saat menerbitkan, satu memulihkannya saat mengonsumsi.
 */

const propagator = new W3CTraceContextPropagator()

/**
 * traceparent untuk konteks yang sedang aktif, atau undefined bila tidak ada
 * trace yang berjalan.
 */
export function currentTraceparent(): string | undefined {
  // Nilai ditangkap lewat closure alih-alih dituliskan ke objek carrier,
  // supaya tidak ada mutasi parameter dan tidak ada nilai bertipe longgar
  // yang merembet keluar dari API propagator.
  let traceparent: string | undefined

  propagator.inject(
    context.active(),
    {},
    {
      set: (_carrier: unknown, key: string, value: unknown) => {
        if (key === 'traceparent' && typeof value === 'string') traceparent = value
      },
    },
  )

  return traceparent
}

/**
 * Menjalankan fungsi di dalam konteks trace yang dipulihkan dari traceparent.
 *
 * Span yang dibuat di dalamnya menjadi anak dari span yang menerbitkan pesan,
 * sehingga seluruh alur — HTTP, penerbitan, konsumsi, saga — tampil sebagai
 * satu trace utuh di Jaeger.
 */
export function withTraceparent<T>(traceparent: string | undefined, fn: () => T): T {
  if (traceparent === undefined || traceparent.length === 0) return fn()

  const carrier: Readonly<Record<string, string>> = { traceparent }
  const extracted = propagator.extract(context.active(), carrier, {
    get: (source: Readonly<Record<string, string>>, key: string) => source[key],
    keys: (source: Readonly<Record<string, string>>) => Object.keys(source),
  })

  return context.with(extracted, fn)
}

/** true bila traceparent menunjuk ke trace yang sah. */
export function isValidTraceparent(traceparent: string | undefined): boolean {
  if (traceparent === undefined) return false

  return withTraceparent(traceparent, () => {
    const spanContext = trace.getSpanContext(context.active())
    return spanContext !== undefined && spanContext.traceId !== '0'.repeat(32)
  })
}
