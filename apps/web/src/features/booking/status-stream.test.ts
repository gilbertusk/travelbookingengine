import { describe, expect, test } from 'vitest'
import {
  isSettled,
  MAX_STREAM_FAILURES,
  parseSse,
  watchBookingStatus,
  type StreamIo,
  type StreamMode,
} from './status-stream'
import type { BookingStatusView } from './types'

function status(overrides: Partial<BookingStatusView> = {}): BookingStatusView {
  return {
    id: 'b-1',
    status: 'PAID',
    isFinal: false,
    version: 4,
    updatedAt: '2026-10-06T10:00:00.000Z',
    heldUntil: '2026-10-06T10:15:00.000Z',
    supplierRef: null,
    failureReason: null,
    refund: null,
    review: null,
    cancellation: null,
    saga: { phase: 'running', step: 'confirmSupplier' },
    serverTime: '2026-10-06T10:00:01.000Z',
    ...overrides,
  }
}

const CONFIRMED = status({
  status: 'CONFIRMED',
  isFinal: true,
  version: 5,
  supplierRef: 'SKY-BK-1',
  saga: { phase: 'completed', step: 'issueVoucher' },
})

function sse(...frames: string[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const frame = (view: BookingStatusView) => `event: status\ndata: ${JSON.stringify(view)}\n\n`

interface Recorder {
  readonly statuses: string[]
  readonly modes: StreamMode[]
  unauthorized: boolean
  readonly done: Promise<void>
  readonly calls: { url: string; auth: string | null }[]
}

/** Menjalankan pengamatan dengan I/O palsu sampai mode `ended` atau `unauthorized`. */
function watch(responses: (() => Promise<Response>)[], io: Partial<StreamIo> = {}): Recorder {
  const calls: { url: string; auth: string | null }[] = []
  let finish: () => void = () => undefined
  const done = new Promise<void>((resolve) => {
    finish = resolve
  })
  const recorder: Recorder = { statuses: [], modes: [], unauthorized: false, done, calls }

  watchBookingStatus({
    bookingId: 'b-1',
    onStatus: (view) => recorder.statuses.push(view.status),
    onMode: (mode) => {
      recorder.modes.push(mode)
      if (mode === 'ended') finish()
    },
    onUnauthorized: () => {
      recorder.unauthorized = true
      finish()
    },
    io: {
      apiUrl: 'http://gateway',
      token: () => 'tok',
      refresh: async () => await Promise.resolve(false),
      sleep: async () => {
        await Promise.resolve()
      },
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers)
        calls.push({ url: urlOf(input), auth: headers.get('authorization') })
        const next = responses.shift()
        if (next === undefined) throw new Error('tidak ada jawaban lagi')
        return await next()
      },
      ...io,
    },
  })

  return recorder
}

describe('mengurai aliran SSE', () => {
  test('peristiwa dipisah baris kosong; komentar penjaga koneksi dibuang', () => {
    const { events, rest } = parseSse(
      ': tetap tersambung\n\nevent: status\nid: 4-2\ndata: {"a":1}\n\nevent: end\ndata: {}\n\n',
    )

    expect(events).toEqual([
      { event: 'status', data: '{"a":1}', id: '4-2' },
      { event: 'end', data: '{}' },
    ])
    expect(rest).toBe('')
  })

  test('peristiwa yang terbelah jaringan disimpan sampai lengkap', () => {
    const first = parseSse('event: status\ndata: {"a"')
    expect(first.events).toEqual([])

    const second = parseSse(`${first.rest}:1}\n\n`)
    expect(second.events).toEqual([{ event: 'status', data: '{"a":1}' }])
  })

  test('baris CRLF dan data bertingkat', () => {
    expect(parseSse('data: satu\r\ndata: dua\r\n\r\n').events).toEqual([
      { event: 'message', data: 'satu\ndua' },
    ])
  })
})

describe('mengamati status', () => {
  test('aliran membawa setiap perubahan sampai server menutupnya dengan end', async () => {
    const recorder = watch([
      async () =>
        await Promise.resolve(sse(frame(status()), frame(CONFIRMED), 'event: end\ndata: {}\n\n')),
    ])

    await recorder.done

    expect(recorder.statuses).toEqual(['PAID', 'CONFIRMED'])
    expect(recorder.modes).toEqual(['connecting', 'live', 'ended'])
    // Token dikirim sebagai header — alasan aliran ini tidak memakai EventSource.
    expect(recorder.calls[0]).toEqual({
      url: 'http://gateway/bookings/stream/b-1',
      auth: 'Bearer tok',
    })
  })

  test('aliran yang putus di tengah disambung ulang', async () => {
    const recorder = watch([
      async () => await Promise.resolve(sse(frame(status()))),
      async () => await Promise.resolve(sse(frame(CONFIRMED), 'event: end\ndata: {}\n\n')),
    ])

    await recorder.done

    expect(recorder.statuses).toEqual(['PAID', 'CONFIRMED'])
    expect(recorder.modes).toContain('reconnecting')
    expect(recorder.calls).toHaveLength(2)
  })

  test(`setelah ${String(MAX_STREAM_FAILURES)} kegagalan beruntun, beralih ke polling sampai final`, async () => {
    const polled: BookingStatusView[] = [status(), CONFIRMED]
    const recorder = watch(
      Array.from({ length: MAX_STREAM_FAILURES }, () => async () => {
        await Promise.resolve()
        throw new TypeError('Failed to fetch')
      }),
      {
        poll: async () => {
          await Promise.resolve()
          const next = polled.shift()
          if (next === undefined) throw new Error('tidak ada lagi')
          return next
        },
      },
    )

    await recorder.done

    expect(recorder.calls).toHaveLength(MAX_STREAM_FAILURES)
    expect(recorder.modes).toContain('polling')
    expect(recorder.statuses).toEqual(['PAID', 'CONFIRMED'])
  })

  test('401 diperbarui sekali; sesi yang tidak dapat diperbarui menghentikan pengamatan', async () => {
    const recorder = watch([async () => await Promise.resolve(new Response(null, { status: 401 }))])

    await recorder.done

    expect(recorder.unauthorized).toBe(true)
  })

  test('401 yang berhasil diperbarui membuka aliran lagi', async () => {
    const recorder = watch(
      [
        async () => await Promise.resolve(new Response(null, { status: 401 })),
        async () => await Promise.resolve(sse(frame(CONFIRMED), 'event: end\ndata: {}\n\n')),
      ],
      { refresh: async () => await Promise.resolve(true) },
    )

    await recorder.done

    expect(recorder.statuses).toEqual(['CONFIRMED'])
  })

  test('peristiwa yang rusak dilewati tanpa memutus aliran', async () => {
    const recorder = watch([
      async () =>
        await Promise.resolve(
          sse('event: status\ndata: {rusak\n\n', frame(CONFIRMED), 'event: end\ndata: {}\n\n'),
        ),
    ])

    await recorder.done

    expect(recorder.statuses).toEqual(['CONFIRMED'])
  })
})

describe('kapan tidak ada lagi yang akan berubah', () => {
  test('final dengan saga selesai', () => {
    expect(isSettled(CONFIRMED)).toBe(true)
  })

  test('final tetapi saga masih melepas hold', () => {
    expect(
      isSettled(
        status({
          status: 'REFUNDED',
          isFinal: true,
          saga: { phase: 'compensating', step: 'awaitPayment' },
        }),
      ),
    ).toBe(false)
  })

  test('belum final', () => {
    expect(isSettled(status())).toBe(false)
  })
})

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}
