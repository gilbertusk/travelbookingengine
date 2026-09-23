import { SpanStatusCode, context, trace } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { createLogger } from '../logger/logger.js'
import { createMetrics, metricsHandler, observeDuration } from './metrics.js'
import { currentTraceparent, isValidTraceparent, withTraceparent } from './propagation.js'
import { annotateSpan, withSpan } from './span.js'
import { currentTraceIds } from './trace-context.js'
import { initTracing, tracingResource } from './tracing.js'

const exporter = new InMemorySpanExporter()
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })

// Provider didaftarkan sekali saja. API OpenTelemetry mengabaikan pendaftaran
// global kedua dan hanya mencatat peringatan, sehingga pendaftaran per-test
// akan diam-diam tidak berlaku dan seluruh span menghilang.
beforeAll(() => {
  // Tanpa context manager, startActiveSpan membuat span tetapi tidak
  // mengaktifkannya: getActiveSpan selalu undefined, span bersarang kehilangan
  // induknya, dan perambatan trace tidak menghasilkan apa pun. Pada produksi
  // NodeSDK mendaftarkannya sendiri; di sini harus manual.
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
  trace.setGlobalTracerProvider(provider)
})

beforeEach(() => {
  exporter.reset()
})

afterAll(async () => {
  await provider.shutdown()
  trace.disable()
  context.disable()
})

const finished = (): readonly ReadableSpan[] => exporter.getFinishedSpans()

describe('withSpan', () => {
  test('membuat span bernama dengan atributnya', async () => {
    await withSpan('supplier.price_check', { supplier: 'SKY' }, async () => Promise.resolve(1))

    expect(finished()[0]?.name).toBe('supplier.price_check')
    expect(finished()[0]?.attributes.supplier).toBe('SKY')
  })

  test('mengembalikan nilai dari fungsi yang dibungkus', async () => {
    const hasil = await withSpan('uji', {}, async () => Promise.resolve('nilai'))

    expect(hasil).toBe('nilai')
  })

  test('menandai span gagal dan mencatat pengecualiannya', async () => {
    // Span yang gagal tanpa ditandai terlihat berhasil di Jaeger, dan
    // pencarian "trace yang gagal" tidak akan menemukannya.
    await expect(
      withSpan('supplier.book', {}, async () => {
        await Promise.resolve()
        throw new Error('supplier menolak')
      }),
    ).rejects.toThrow('supplier menolak')

    const span = finished()[0]
    expect(span?.status.code).toBe(SpanStatusCode.ERROR)
    expect(span?.status.message).toBe('supplier menolak')
    expect(span?.events.some((event) => event.name === 'exception')).toBe(true)
  })

  test('span tetap ditutup meski fungsinya melempar', async () => {
    await expect(
      withSpan('uji', {}, async () => {
        await Promise.resolve()
        throw new Error('gagal')
      }),
    ).rejects.toThrow()

    expect(finished()).toHaveLength(1)
  })

  test('span bersarang menjadi anak dari span induknya', async () => {
    await withSpan('booking.saga', {}, async () => {
      await withSpan('supplier.confirm', {}, async () => Promise.resolve())
    })

    const anak = finished().find((span) => span.name === 'supplier.confirm')
    const induk = finished().find((span) => span.name === 'booking.saga')
    expect(anak?.parentSpanContext?.spanId).toBe(induk?.spanContext().spanId)
    expect(anak?.spanContext().traceId).toBe(induk?.spanContext().traceId)
  })

  test('annotateSpan menambahkan atribut ke span yang aktif', async () => {
    await withSpan('uji', {}, async () => {
      annotateSpan({ 'booking.id': 'bkg_1' })
      await Promise.resolve()
    })

    expect(finished()[0]?.attributes['booking.id']).toBe('bkg_1')
  })

  test('annotateSpan diam saja di luar span', () => {
    expect(() => {
      annotateSpan({ apa: 'pun' })
    }).not.toThrow()
  })
})

describe('trace context', () => {
  test('mengembalikan objek kosong di luar span', () => {
    expect(currentTraceIds()).toEqual({})
  })

  test('mengembalikan traceId dan spanId di dalam span', async () => {
    let ids: ReturnType<typeof currentTraceIds> = {}

    await withSpan('uji', {}, async () => {
      ids = currentTraceIds()
      await Promise.resolve()
    })

    expect(ids.traceId).toMatch(/^[0-9a-f]{32}$/)
    expect(ids.spanId).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('log dan trace', () => {
  test('setiap baris log membawa traceId span yang aktif', async () => {
    // Tanpa ini, menghubungkan sebuah galat ke span tempat ia terjadi berarti
    // mencocokkan cap waktu dengan mata.
    const captured: string[] = []
    const log = createLogger({
      serviceName: 'uji',
      level: 'info',
      destination: {
        write(chunk: string): void {
          captured.push(chunk)
        },
      },
    })

    await withSpan('booking.saga', {}, async () => {
      log.info('langkah saga dijalankan')
      await Promise.resolve()
    })

    const baris = JSON.parse(captured[0] ?? '{}') as Record<string, unknown>
    expect(baris.traceId).toMatch(/^[0-9a-f]{32}$/)
    expect(baris.spanId).toMatch(/^[0-9a-f]{16}$/)
  })

  test('log di luar span tidak membawa traceId', () => {
    const captured: string[] = []
    const log = createLogger({
      serviceName: 'uji',
      level: 'info',
      destination: {
        write(chunk: string): void {
          captured.push(chunk)
        },
      },
    })

    log.info('pekerjaan terjadwal')

    expect(JSON.parse(captured[0] ?? '{}')).not.toHaveProperty('traceId')
  })
})

describe('perambatan lewat amplop pesan', () => {
  test('menghasilkan traceparent di dalam span', async () => {
    let traceparent: string | undefined

    await withSpan('publish', {}, async () => {
      traceparent = currentTraceparent()
      await Promise.resolve()
    })

    expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/)
  })

  test('tidak menghasilkan traceparent di luar span', () => {
    expect(currentTraceparent()).toBeUndefined()
  })

  test('memulihkan trace yang sama di sisi consumer', async () => {
    // Inilah yang menyambung trace yang terputus saat alur berpindah dari HTTP
    // ke saga asinkron.
    let traceparent: string | undefined
    let traceIdPenerbit = ''

    await withSpan('publish', {}, async () => {
      traceparent = currentTraceparent()
      traceIdPenerbit = currentTraceIds().traceId ?? ''
      await Promise.resolve()
    })

    await withTraceparent(traceparent, async () => {
      await withSpan('consume', {}, async () => Promise.resolve())
    })

    const konsumen = finished().find((span) => span.name === 'consume')
    expect(konsumen?.spanContext().traceId).toBe(traceIdPenerbit)
  })

  test('span consumer menjadi anak dari span penerbit', async () => {
    let traceparent: string | undefined
    let spanIdPenerbit = ''

    await withSpan('publish', {}, async () => {
      traceparent = currentTraceparent()
      spanIdPenerbit = currentTraceIds().spanId ?? ''
      await Promise.resolve()
    })

    await withTraceparent(traceparent, async () => {
      await withSpan('consume', {}, async () => Promise.resolve())
    })

    expect(finished().find((s) => s.name === 'consume')?.parentSpanContext?.spanId).toBe(
      spanIdPenerbit,
    )
  })

  test('traceparent yang hilang tidak menggagalkan konsumsi', async () => {
    // Pesan lama yang diterbitkan sebelum instrumentasi ada tetap harus dapat
    // dikonsumsi, hanya tanpa induk.
    await expect(withTraceparent(undefined, async () => Promise.resolve('selesai'))).resolves.toBe(
      'selesai',
    )
    await expect(withTraceparent('', async () => Promise.resolve('selesai'))).resolves.toBe(
      'selesai',
    )
  })

  test('mengenali traceparent yang sah dan yang tidak', async () => {
    let traceparent: string | undefined
    await withSpan('publish', {}, async () => {
      traceparent = currentTraceparent()
      await Promise.resolve()
    })

    expect(isValidTraceparent(traceparent)).toBe(true)
    expect(isValidTraceparent(undefined)).toBe(false)
    expect(isValidTraceparent('bukan-traceparent')).toBe(false)
  })
})

describe('metrik', () => {
  test('mendaftarkan seluruh metrik domain yang dipakai step berikutnya', async () => {
    const { registry } = createMetrics({ serviceName: 'uji' })
    const teks = await registry.metrics()

    for (const name of [
      'supplier_request_duration_seconds',
      'supplier_circuit_state',
      'supplier_retry_total',
      'search_cache_hits_total',
      'search_cache_misses_total',
      'booking_saga_step_total',
      'http_request_duration_seconds',
    ]) {
      expect(teks).toContain(name)
    }
  })

  test('menyertakan nama service sebagai label bawaan', async () => {
    const { registry } = createMetrics({ serviceName: 'booking-service' })
    const { domain } = createMetrics({ serviceName: 'booking-service' })
    domain.searchCacheHits.inc({ layer: 'combined' })

    expect(await registry.metrics()).toContain('service="booking-service"')
  })

  test('menyertakan metrik proses Node bawaan', async () => {
    const { registry } = createMetrics({ serviceName: 'uji' })

    expect(await registry.metrics()).toContain('process_cpu_user_seconds_total')
  })

  test('bucket latensi supplier cukup halus untuk membedakan 0,2 dan 0,8 detik', async () => {
    // Bucket bawaan prom-client terlalu kasar untuk M1, yang mengukur p95 di
    // bawah 800ms pada supplier yang latensinya 200ms sampai 3 detik.
    const { registry, domain } = createMetrics({ serviceName: 'uji' })
    domain.supplierRequestDuration.observe(
      { supplier: 'SKY', operation: 'search', outcome: 'success' },
      0.3,
    )

    const teks = await registry.metrics()
    expect(teks).toContain('le="0.2"')
    expect(teks).toContain('le="0.8"')
  })

  test('observeDuration menandai keberhasilan dan kegagalan terpisah', async () => {
    // Mencatat durasi tanpa membedakan hasil membuat p95 menyesatkan:
    // permintaan yang gagal cepat menarik angka ke bawah.
    const { registry, domain } = createMetrics({ serviceName: 'uji' })

    await observeDuration(
      domain.supplierRequestDuration,
      { supplier: 'SKY', operation: 'search' },
      async () => Promise.resolve('ok'),
    )
    await expect(
      observeDuration(
        domain.supplierRequestDuration,
        { supplier: 'LUNA', operation: 'search' },
        async () => {
          await Promise.resolve()
          throw new Error('timeout')
        },
      ),
    ).rejects.toThrow()

    const teks = await registry.metrics()
    expect(teks).toContain('outcome="success"')
    expect(teks).toContain('outcome="failure"')
  })

  test('handler metrik membalas dengan content-type Prometheus', async () => {
    const { registry } = createMetrics({ serviceName: 'uji' })
    let contentType = ''
    let body = ''

    const res = {
      setHeader: (_name: string, value: string) => {
        contentType = value
      },
      send: (payload: string) => {
        body = payload
      },
      status: () => res,
      end: () => res,
    }

    metricsHandler(registry)(
      {} as Parameters<ReturnType<typeof metricsHandler>>[0],
      res as unknown as Parameters<ReturnType<typeof metricsHandler>>[1],
      () => undefined,
    )
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(contentType).toContain('text/plain')
    expect(body).toContain('# HELP')
  })
})

describe('inisialisasi penelusuran', () => {
  test('mengembalikan undefined ketika dimatikan', () => {
    // Pengujian tidak butuh instrumentasi, dan menyalakannya di sana hanya
    // meninggalkan eksportir yang mencoba menyambung ke collector.
    expect(initTracing({ serviceName: 'uji', enabled: false })).toBeUndefined()
  })

  test('sumber daya penelusuran aman ditutup meski SDK tidak menyala', async () => {
    const resource = tracingResource(undefined)

    expect(resource.name).toBe('tracing')
    await expect(resource.stop()).resolves.toBeUndefined()
  })
})
