import { publicConfig } from '@/config'
import { getAccessToken } from '@/lib/access-token'
import { refreshAccessToken } from '@/lib/api-client'
import { fetchStatus, parse } from './api'
import { statusSchema, type BookingStatusView } from './types'

/**
 * Status pemesanan secara langsung (FR-26): Server-Sent Events, lalu polling.
 *
 * **Bukan `EventSource`.** EventSource tidak dapat mengirim header
 * `Authorization`, dan access token di aplikasi ini hanya ada di memori —
 * sengaja, bukan di cookie yang dapat dibaca skrip mana pun. Alirannya dibaca
 * lewat `fetch` dan diurai sendiri; formatnya sederhana dan diuji di sini.
 *
 * Tiga lapis ketahanan, berurutan:
 *
 * 1. **Sambung ulang otomatis** dengan jeda yang memanjang. Aliran yang putus
 *    di tengah — proxy yang menutup koneksi diam, jaringan seluler yang
 *    berpindah menara — bukan kegagalan, hanya alasan untuk menyambung lagi.
 * 2. **Cadangan polling** setelah beberapa kegagalan BERUNTUN. Ada jaringan
 *    yang memang tidak meneruskan aliran panjang; pengguna di sana tetap harus
 *    melihat statusnya berubah, hanya sedikit lebih lambat.
 * 3. **Berhenti** ketika pemesanan tuntas — server mengirim `event: end`, atau
 *    polling membaca keadaan final.
 */

export type StreamMode = 'connecting' | 'live' | 'reconnecting' | 'polling' | 'ended'

export interface SseEvent {
  readonly event: string
  readonly data: string
  readonly id?: string
}

/**
 * Mengurai potongan aliran. Peristiwa dipisah baris kosong; baris yang diawali
 * `:` adalah komentar penjaga koneksi dan dibuang. Sisa yang belum lengkap
 * dikembalikan untuk digabung dengan potongan berikutnya — satu peristiwa
 * dapat terbelah di tengah oleh jaringan.
 */
export function parseSse(buffer: string): { events: SseEvent[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, '\n')
  const blocks = normalized.split('\n\n')
  const rest = blocks.pop() ?? ''
  const events: SseEvent[] = []

  for (const block of blocks) {
    let event = 'message'
    const data: string[] = []
    let id: string | undefined

    for (const line of block.split('\n')) {
      if (line.length === 0 || line.startsWith(':')) continue
      const colon = line.indexOf(':')
      const field = colon === -1 ? line : line.slice(0, colon)
      const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '')
      if (field === 'event') event = value
      else if (field === 'data') data.push(value)
      else if (field === 'id') id = value
    }

    if (data.length > 0 || event !== 'message') {
      events.push({ event, data: data.join('\n'), ...(id === undefined ? {} : { id }) })
    }
  }

  return { events, rest }
}

/** Jeda sebelum menyambung ulang, menurut banyaknya kegagalan beruntun. */
export const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000] as const

/** Setelah sekian kegagalan beruntun, aliran ditinggalkan untuk polling. */
export const MAX_STREAM_FAILURES = 3

export const POLL_INTERVAL_MS = 3_000

export interface WatchOptions {
  readonly bookingId: string
  readonly onStatus: (status: BookingStatusView) => void
  readonly onMode: (mode: StreamMode) => void
  /** Sesi habis dan tidak dapat diperbarui. Pengamatan berhenti. */
  readonly onUnauthorized: () => void
  /** Untuk uji. Bawaannya implementasi sungguhan. */
  readonly io?: Partial<StreamIo>
}

export interface StreamIo {
  readonly fetch: typeof fetch
  readonly token: () => string | undefined
  readonly refresh: () => Promise<boolean>
  readonly poll: (bookingId: string, signal: AbortSignal) => Promise<BookingStatusView>
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>
  readonly apiUrl: string
}

const defaultIo: StreamIo = {
  fetch: (...args) => fetch(...args),
  token: getAccessToken,
  refresh: refreshAccessToken,
  poll: fetchStatus,
  sleep: async (ms, signal) => {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms)
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
    })
  },
  apiUrl: publicConfig.apiUrl,
}

/** Mulai mengamati. Fungsi yang dikembalikan menghentikannya. */
export function watchBookingStatus(options: WatchOptions): () => void {
  const io: StreamIo = { ...defaultIo, ...options.io }
  const controller = new AbortController()

  void run(options, io, controller.signal).catch(() => {
    // Galat yang lolos dari kedua lapis hanya mungkin cacat program; jangan
    // biarkan menjadi penolakan janji yang tidak tertangani di konsol pengguna.
    if (!controller.signal.aborted) options.onMode('polling')
  })

  return () => {
    controller.abort()
  }
}

async function run(options: WatchOptions, io: StreamIo, signal: AbortSignal): Promise<void> {
  let failures = 0
  options.onMode('connecting')

  while (!signal.aborted && failures < MAX_STREAM_FAILURES) {
    const outcome = await streamOnce(options, io, signal)
    if (outcome === 'ended' || outcome === 'aborted') {
      if (outcome === 'ended') options.onMode('ended')
      return
    }
    if (outcome === 'unauthorized') {
      options.onUnauthorized()
      return
    }

    failures = outcome === 'dropped_after_events' ? 1 : failures + 1
    if (failures >= MAX_STREAM_FAILURES) break
    options.onMode('reconnecting')
    await io.sleep(RECONNECT_DELAYS_MS[failures - 1] ?? POLL_INTERVAL_MS, signal)
  }

  if (!signal.aborted) await pollUntilFinal(options, io, signal)
}

type StreamOutcome =
  | 'ended'
  | 'aborted'
  | 'unauthorized'
  | 'failed'
  /** Aliran sempat hidup lalu putus. Sambung lagi tanpa menghitungnya kegagalan beruntun. */
  | 'dropped_after_events'

async function streamOnce(
  options: WatchOptions,
  io: StreamIo,
  signal: AbortSignal,
): Promise<StreamOutcome> {
  let response: Response
  try {
    response = await open(options.bookingId, io, signal)
    if (response.status === 401) {
      if (!(await io.refresh())) return 'unauthorized'
      response = await open(options.bookingId, io, signal)
    }
  } catch {
    return signal.aborted ? 'aborted' : 'failed'
  }

  if (response.status === 401) return 'unauthorized'
  if (!response.ok || response.body === null) return 'failed'

  let received = false
  try {
    for await (const event of readEvents(response.body)) {
      if (event.event === 'end') return 'ended'
      const status = event.event === 'status' ? parseStatus(event.data) : undefined
      if (status === undefined) continue
      if (!received) options.onMode('live')
      received = true
      options.onStatus(status)
    }
  } catch {
    // Aliran yang putus di tengah sama dengan aliran yang selesai tanpa `end`.
  }

  if (signal.aborted) return 'aborted'
  return received ? 'dropped_after_events' : 'failed'
}

/** Peristiwa SSE dari badan respons, satu per satu, sampai alirannya selesai. */
async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  // `stream: true`: satu karakter UTF-8 dapat terbelah di antara dua potongan.
  const decoder = new TextDecoder()
  let buffer = ''

  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) return
    const { events, rest } = parseSse(buffer + decoder.decode(chunk.value, { stream: true }))
    buffer = rest
    yield* events
  }
}

async function open(bookingId: string, io: StreamIo, signal: AbortSignal): Promise<Response> {
  const token = io.token()
  const headers: Record<string, string> = { accept: 'text/event-stream' }
  if (token !== undefined) headers.authorization = `Bearer ${token}`

  return await io.fetch(`${io.apiUrl}/bookings/stream/${encodeURIComponent(bookingId)}`, {
    headers,
    signal,
    cache: 'no-store',
  })
}

function parseStatus(data: string): BookingStatusView | undefined {
  try {
    return parse(statusSchema, JSON.parse(data))
  } catch {
    // Satu peristiwa yang rusak tidak memutus aliran; yang berikutnya membawa
    // keadaan lengkap lagi.
    return undefined
  }
}

async function pollUntilFinal(
  options: WatchOptions,
  io: StreamIo,
  signal: AbortSignal,
): Promise<void> {
  options.onMode('polling')

  while (!signal.aborted) {
    try {
      const status = await io.poll(options.bookingId, signal)
      options.onStatus(status)
      if (status.isFinal && isSettled(status)) {
        options.onMode('ended')
        return
      }
    } catch {
      // Polling yang gagal sekali tidak menghentikan apa pun; jaringan yang
      // pulih akan menjawab putaran berikutnya.
    }
    await io.sleep(POLL_INTERVAL_MS, signal)
  }
}

/**
 * Tidak ada lagi yang akan berubah bagi pengguna: keadaan final dan sagannya
 * tidak sedang bekerja. REFUNDED yang sagannya masih berjalan, misalnya,
 * masih menunggu kabar hold-nya dilepas — sama dengan aturan `end` di server.
 */
export function isSettled(status: BookingStatusView): boolean {
  if (!status.isFinal) return false
  return status.saga === null || !['running', 'compensating'].includes(status.saga.phase)
}
