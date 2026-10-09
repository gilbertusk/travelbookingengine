import { money, moneySchema } from '@tbe/money'
import { UpstreamError } from '@tbe/shared-kernel'
import { request } from 'undici'
import { z } from 'zod'
import type { BookingDirectory, PropertyDirectory, SourceLookup } from '../application/ports.js'
import {
  SUPPLIER_CODES,
  type CancellationPolicy,
  type VoucherProperty,
  type VoucherSource,
} from '../domain/voucher.js'

/**
 * Pintu ke booking-service dan katalog search-service.
 *
 * Keduanya service internal, tetapi jawabannya tetap divalidasi
 * (CONVENTIONS.md bagian 6). Service yang dikerahkan ulang dengan bentuk
 * jawaban berbeda harus gagal di sini — sebagai galat yang dicoba lagi lalu
 * berakhir di dead letter — bukan sebagai `undefined` yang tercetak di voucher.
 *
 * Penerjemahan jawaban dipisahkan dari pemanggilannya, supaya keputusan
 * status mana berarti apa dapat diuji tanpa soket terbuka.
 */

export interface HttpResponse {
  readonly status: number
  readonly body: unknown
}

export type Transport = (url: string) => Promise<HttpResponse>

const envelope = <T extends z.ZodType>(data: T) => z.object({ data, error: z.null() })

const stayDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

const sourceSchema = envelope(
  z.object({
    id: z.uuid(),
    userId: z.uuid(),
    status: z.string().min(1),
    supplier: z.enum(SUPPLIER_CODES),
    supplierRef: z.string().nullable(),
    confirmedAt: z.iso.datetime().nullable(),
    propertyId: z.string().min(1),
    checkIn: stayDate,
    checkOut: stayDate,
    guests: z.object({ count: z.number().int().positive(), leadGuestName: z.string().min(1) }),
    price: z.object({
      total: moneySchema,
      lineItems: z.array(
        z.object({
          kind: z.enum(['room_night', 'tax', 'fee']),
          description: z.string(),
          amount: moneySchema,
        }),
      ),
    }),
    terms: z
      .object({
        roomTypeName: z.string().min(1),
        ratePlanName: z.string().min(1),
        breakfastIncluded: z.boolean(),
        cancellationPolicy: z.discriminatedUnion('refundable', [
          z.object({ refundable: z.literal(false) }),
          z.object({
            refundable: z.literal(true),
            freeCancellationDays: z.number().int().nonnegative().optional(),
          }),
        ]),
      })
      .nullable(),
  }),
)

const propertySchema = envelope(
  z.object({
    name: z.string().min(1),
    address: z.string(),
    city: z.string(),
    phone: z.string().min(1).optional(),
    email: z.string().min(1).optional(),
  }),
)

const notFoundEnvelope = z.object({ error: z.object({ code: z.literal('NOT_FOUND') }) })

/**
 * 404 yang SAH: dijawab service itu sendiri, dengan amplop galat NOT_FOUND.
 *
 * 404 telanjang — URL dasar yang salah, rute yang belum dikerahkan, proxy yang
 * salah arah — bukan jawaban tentang pemesanan. Menganggapnya "tidak ada"
 * membuat perintah voucher untuk pemesanan yang sudah dibayar langsung masuk
 * dead letter tanpa satu pun percobaan ulang.
 */
function isGenuineNotFound(response: HttpResponse): boolean {
  return response.status === 404 && notFoundEnvelope.safeParse(response.body).success
}

export function toSourceLookup(response: HttpResponse): SourceLookup {
  if (isGenuineNotFound(response)) return { kind: 'not_found' }

  const parsed = response.status === 200 ? sourceSchema.safeParse(response.body) : undefined
  if (parsed?.success !== true) throw unusable('booking-service', response)

  return { kind: 'found', source: toSource(parsed.data.data) }
}

function toSource(data: z.infer<typeof sourceSchema>['data']): VoucherSource {
  return {
    bookingId: data.id,
    userId: data.userId,
    status: data.status,
    supplier: data.supplier,
    supplierRef: data.supplierRef,
    confirmedAt: data.confirmedAt === null ? null : new Date(data.confirmedAt),
    supplierPropertyId: data.propertyId,
    checkIn: data.checkIn,
    checkOut: data.checkOut,
    guestCount: data.guests.count,
    leadGuestName: data.guests.leadGuestName,
    total: money(data.price.total.amountMinor, data.price.total.currency),
    lines: data.price.lineItems.map((line) => ({
      kind: line.kind,
      description: line.description,
      amount: money(line.amount.amountMinor, line.amount.currency),
    })),
    terms:
      data.terms === null
        ? null
        : {
            roomTypeName: data.terms.roomTypeName,
            ratePlanName: data.terms.ratePlanName,
            breakfastIncluded: data.terms.breakfastIncluded,
            cancellationPolicy: policyOf(data.terms.cancellationPolicy),
          },
  }
}

type PolicyJson = NonNullable<z.infer<typeof sourceSchema>['data']['terms']>['cancellationPolicy']

function policyOf(policy: PolicyJson): CancellationPolicy {
  if (!policy.refundable) return { refundable: false }

  return policy.freeCancellationDays === undefined
    ? { refundable: true }
    : { refundable: true, freeCancellationDays: policy.freeCancellationDays }
}

export function toProperty(response: HttpResponse): VoucherProperty | undefined {
  if (isGenuineNotFound(response)) return undefined

  const parsed = response.status === 200 ? propertySchema.safeParse(response.body) : undefined
  if (parsed?.success !== true) throw unusable('search-service', response)

  const { phone, email, ...rest } = parsed.data.data
  return {
    ...rest,
    ...(phone === undefined ? {} : { phone }),
    ...(email === undefined ? {} : { email }),
  }
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
    async voucherSource(bookingId) {
      const id = encodeURIComponent(bookingId)
      return toSourceLookup(await transport(`${baseUrl}/internal/bookings/${id}/voucher-source`))
    },
  }
}

export function createHttpPropertyDirectory(
  baseUrl: string,
  transport: Transport,
): PropertyDirectory {
  return {
    async bySupplier(supplier, supplierPropertyId) {
      const path = `${encodeURIComponent(supplier)}/${encodeURIComponent(supplierPropertyId)}`
      return toProperty(
        await transport(`${baseUrl}/internal/catalog/properties/by-supplier/${path}`),
      )
    },
  }
}

/**
 * Transport undici. Kegagalan jaringan dan batas waktu menjadi status 0 —
 * "tidak ada jawaban" — supaya ditangani di satu tempat yang sama dengan 5xx.
 */
export function undiciTransport(
  timeoutMs: number,
  correlationHeader: () => Record<string, string>,
): Transport {
  return async (url) => {
    try {
      const response = await request(url, {
        method: 'GET',
        headers: correlationHeader(),
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
      })
      const payload: unknown = await response.body.json()

      return { status: response.statusCode, body: payload }
    } catch (error) {
      return { status: 0, body: { error: { code: 'NETWORK', message: String(error) } } }
    }
  }
}
