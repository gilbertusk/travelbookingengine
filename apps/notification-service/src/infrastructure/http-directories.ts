import { UpstreamError } from '@tbe/shared-kernel'
import { request } from 'undici'
import { z } from 'zod'
import type { BookingDirectory, SnapshotLookup, VoucherDocuments } from '../application/ports.js'

/**
 * Pintu ke booking-service dan voucher-service, lewat rute `/internal` yang
 * tidak dirutekan api-gateway.
 *
 * Jawaban tetap divalidasi (CONVENTIONS.md bagian 6). Penerjemahan jawaban
 * dipisahkan dari pemanggilannya supaya keputusan status mana berarti apa
 * dapat diuji tanpa soket — pola yang sama dengan voucher-service.
 */

export interface HttpResponse {
  readonly status: number
  readonly contentType: string
  readonly body: Uint8Array
}

export type Transport = (url: string) => Promise<HttpResponse>

const stayDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

const sourceSchema = z.object({
  data: z.object({
    id: z.uuid(),
    userId: z.uuid(),
    status: z.string().min(1),
    supplierRef: z.string().min(1).nullable(),
    checkIn: stayDate,
    checkOut: stayDate,
    guestCount: z.number().int().positive(),
    leadGuest: z.object({ fullName: z.string().min(1), email: z.string().min(1) }),
    roomTypeName: z.string().min(1).nullable(),
    total: z.object({ amountMinor: z.number().int(), currency: z.enum(['IDR', 'USD']) }),
  }),
  error: z.null(),
})

const notFoundEnvelope = z.object({ error: z.object({ code: z.literal('NOT_FOUND') }) })

/** `undefined` bila jawabannya bukan JSON yang dapat diurai. */
function jsonOf(response: HttpResponse): unknown {
  if (!response.contentType.includes('application/json')) return undefined

  try {
    return JSON.parse(new TextDecoder().decode(response.body)) as unknown
  } catch {
    // JSON rusak adalah jawaban yang tidak dapat dipakai, bukan galat di sini:
    // pemanggil melemparnya sebagai galat sementara bersama status jawabannya.
    return undefined
  }
}

/**
 * 404 yang SAH: dijawab service itu sendiri, dengan amplop galat NOT_FOUND.
 * 404 telanjang — URL dasar salah, rute belum dikerahkan — dicoba lagi.
 */
function isGenuineNotFound(response: HttpResponse): boolean {
  return response.status === 404 && notFoundEnvelope.safeParse(jsonOf(response)).success
}

export function toSnapshotLookup(response: HttpResponse): SnapshotLookup {
  if (isGenuineNotFound(response)) return { kind: 'not_found' }

  const parsed = response.status === 200 ? sourceSchema.safeParse(jsonOf(response)) : undefined
  if (parsed?.success !== true) throw unusable('booking-service', response)

  const { id, ...rest } = parsed.data.data
  return { kind: 'found', booking: { bookingId: id, ...rest } }
}

export function toDocument(response: HttpResponse): Uint8Array | undefined {
  if (isGenuineNotFound(response)) return undefined

  if (response.status !== 200 || !response.contentType.startsWith('application/pdf')) {
    throw unusable('voucher-service', response)
  }
  return response.body
}

function unusable(upstream: string, response: HttpResponse): UpstreamError {
  return new UpstreamError({
    upstream,
    message: `${upstream} tidak memberi jawaban yang dapat dipakai`,
    details: { status: response.status },
  })
}

export function createHttpBookingDirectory(
  baseUrl: string,
  transport: Transport,
): BookingDirectory {
  return {
    async notificationSource(bookingId) {
      const id = encodeURIComponent(bookingId)
      return toSnapshotLookup(
        await transport(`${baseUrl}/internal/bookings/${id}/notification-source`),
      )
    },
  }
}

export function createHttpVoucherDocuments(
  baseUrl: string,
  transport: Transport,
): VoucherDocuments {
  return {
    async document(bookingId) {
      const id = encodeURIComponent(bookingId)
      return toDocument(await transport(`${baseUrl}/internal/vouchers/${id}/document`))
    },
  }
}

/**
 * Transport undici. Kegagalan jaringan dan batas waktu menjadi status 0 —
 * "tidak ada jawaban" — supaya ditangani di satu tempat yang sama dengan 5xx.
 * Penyebab aslinya tidak ikut dalam jawaban, jadi diserahkan ke `onNetworkError`
 * untuk dicatat.
 */
export function undiciTransport(
  timeoutMs: number,
  correlationHeader: () => Record<string, string>,
  onNetworkError: (url: string, error: unknown) => void,
): Transport {
  return async (url) => {
    try {
      const response = await request(url, {
        method: 'GET',
        headers: correlationHeader(),
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
      })
      const contentType = response.headers['content-type']
      return {
        status: response.statusCode,
        contentType: typeof contentType === 'string' ? contentType : '',
        body: new Uint8Array(await response.body.arrayBuffer()),
      }
    } catch (error) {
      onNetworkError(url, error)
      return { status: 0, contentType: '', body: new Uint8Array() }
    }
  }
}
