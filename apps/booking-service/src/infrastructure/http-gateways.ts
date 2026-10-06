import { money, moneySchema, toJson, type MoneyJson } from '@tbe/money'
import { holdResultSchema, priceCheckResultSchema } from '@tbe/supplier-adapters'
import { request } from 'undici'
import { z } from 'zod'
import type {
  Payments,
  PaymentStart,
  Pricing,
  PricingRequest,
  RatePlanStay,
  SupplierAnswer,
  SupplierHold,
  SupplierQuotes,
} from '../application/ports.js'
import type { SellQuote } from '../domain/sell-price.js'

/**
 * Pintu ke supplier-service dan pricing-service.
 *
 * Keduanya service internal, tetapi jawabannya tetap divalidasi — pola yang
 * sama dengan search-service. Service yang dikerahkan ulang dengan bentuk
 * jawaban berbeda harus gagal di sini, bukan sebagai `undefined` di tengah
 * perhitungan harga yang akan ditagih.
 *
 * Tidak ada cache di sini, dan tidak ada header yang meminta cache. Price
 * check adalah satu permintaan HTTP ke supplier-service per pemanggilan.
 *
 * Penerjemahan jawaban dipisahkan dari pemanggilannya, supaya keputusan —
 * status mana yang berarti apa — dapat diuji tanpa soket terbuka.
 */

export interface HttpResponse {
  readonly status: number
  readonly body: unknown
}

export type Transport = (url: string, body: unknown) => Promise<HttpResponse>

const envelope = <T extends z.ZodType>(data: T) => z.object({ data, error: z.null() })
const errorEnvelope = z.object({ error: z.object({ code: z.string() }) })

/**
 * Status supplier-service menjadi keputusan booking-service.
 *
 * Hanya dua jawaban yang berarti "tidak, dan tidak akan berubah": kamar habis
 * (409 SOLD_OUT) dan rate plan tidak ada (404). Selain itu — timeout, pemutus
 * terbuka, galat supplier, bahkan 409 lain seperti PRICE_CHANGED — adalah
 * "belum ada jawaban yang dapat dipakai", dan pengguna boleh mencoba lagi.
 * Menganggapnya penolakan akan membatalkan pemesanan karena supplier lambat
 * sesaat; price check berikutnya yang akan melihat perubahan harganya sendiri.
 */
export function toSupplierAnswer<T>(
  response: HttpResponse,
  schema: z.ZodType<T>,
): SupplierAnswer<T> {
  if (response.status === 200) {
    const parsed = envelope(schema).safeParse(response.body)
    return parsed.success ? { kind: 'ok', value: parsed.data.data } : { kind: 'unreachable' }
  }

  if (response.status === 404) return { kind: 'rejected', reason: 'not_found' }

  const code = errorEnvelope.safeParse(response.body)
  if (response.status === 409 && code.success && code.data.error.code === 'SOLD_OUT') {
    return { kind: 'rejected', reason: 'sold_out' }
  }

  return { kind: 'unreachable' }
}

/**
 * Uang yang SUDAH lolos `moneySchema`: mata uangnya enum yang dikenal dan
 * jumlahnya bilangan bulat. Versi pertama mengurainya lagi dengan `fromJson`
 * dan menangani kegagalannya; cakupan uji memperlihatkan cabang itu tidak
 * pernah tersentuh, karena memang tidak dapat — skema sudah menolaknya lebih
 * dulu. Penanganan untuk kegagalan yang mustahil dihapus.
 */
const toMoney = (value: MoneyJson) => money(value.amountMinor, value.currency)

const priceCheckSchema = priceCheckResultSchema.transform((value) => ({
  total: toMoney(value.total),
}))

const holdSchema = holdResultSchema.transform((value): SupplierHold => ({
  holdRef: value.supplierHoldId,
  expiresAt: new Date(value.expiresAt),
  total: toMoney(value.total),
}))

export function createHttpSupplierQuotes(baseUrl: string, transport: Transport): SupplierQuotes {
  return {
    async priceCheck(stay: RatePlanStay) {
      const response = await transport(`${baseUrl}/internal/suppliers/price-check`, stay)
      return toSupplierAnswer(response, priceCheckSchema)
    },
    async hold(stay) {
      const response = await transport(`${baseUrl}/internal/suppliers/hold`, stay)
      return toSupplierAnswer(response, holdSchema)
    },
  }
}

const pricedSchema = envelope(
  z.object({
    priced: z.array(
      z.object({
        ref: z.string(),
        breakdown: z.object({
          base: moneySchema,
          markup: moneySchema,
          tax: moneySchema,
          total: moneySchema,
          taxName: z.string(),
        }),
      }),
    ),
  }),
)

/**
 * Jawaban pricing-service untuk SATU rate plan.
 *
 * Item yang gagal dihitung ada di daftar `failed`, bukan `priced`, dan
 * dijawab `undefined`. Mengambil harga supplier sebagai gantinya berarti
 * menjual tanpa markup — dan menyetujui harga itu atas nama pengguna.
 */
export function toSellQuote(response: HttpResponse, ref: string): SellQuote | undefined {
  if (response.status !== 200) return undefined

  const parsed = pricedSchema.safeParse(response.body)
  if (!parsed.success) return undefined

  const item = parsed.data.data.priced.find((candidate) => candidate.ref === ref)
  if (item === undefined) return undefined

  const { base, markup, tax, total, taxName } = item.breakdown

  return {
    base: toMoney(base),
    markup: toMoney(markup),
    tax: toMoney(tax),
    total: toMoney(total),
    taxName,
  }
}

export function createHttpPricing(baseUrl: string, transport: Transport): Pricing {
  return {
    async sellPrice(item: PricingRequest) {
      const response = await transport(`${baseUrl}/internal/pricing/rate-plans`, { items: [item] })
      return toSellQuote(response, item.ref)
    },
  }
}

const intentSchema = envelope(
  z.object({
    payment: z.object({ id: z.string().min(1), status: z.string().min(1) }),
    redirectUrl: z.string().min(1).optional(),
    snapToken: z.string().min(1).optional(),
  }),
)

/**
 * Jawaban payment-service atas `POST /internal/payments` menjadi keputusan.
 *
 * 409 berarti harga yang disetujui belum dikenal payment-service — peristiwa
 * pemesanan belum terbaca — dan itu sementara. 402 berarti penyedia menolak.
 * Selain itu, termasuk bentuk jawaban yang tidak dikenal, adalah "belum ada
 * jawaban yang dapat dipakai".
 */
export function toPaymentStart(response: HttpResponse): PaymentStart {
  if (response.status === 409) return { kind: 'not_ready' }
  if (response.status === 402) return { kind: 'rejected' }
  if (response.status !== 200 && response.status !== 201) return { kind: 'unreachable' }

  const parsed = intentSchema.safeParse(response.body)
  if (!parsed.success) return { kind: 'unreachable' }

  const { payment, redirectUrl, snapToken } = parsed.data.data
  if (redirectUrl === undefined || snapToken === undefined) {
    return { kind: 'settled', paymentId: payment.id, status: payment.status }
  }

  return { kind: 'started', paymentId: payment.id, redirectUrl, snapToken }
}

export function createHttpPayments(baseUrl: string, transport: Transport): Payments {
  return {
    async start(request) {
      const response = await transport(`${baseUrl}/internal/payments`, {
        bookingId: request.bookingId,
        idempotencyKey: request.idempotencyKey,
        amount: toJson(request.amount),
      })
      return toPaymentStart(response)
    },
  }
}

/**
 * Transport undici. Kegagalan jaringan dan batas waktu menjadi status 0 —
 * "tidak ada jawaban" — bukan pengecualian, supaya ditangani di satu tempat
 * yang sama dengan 5xx.
 */
export function undiciTransport(
  timeoutMs: number,
  correlationHeader: () => Record<string, string>,
): Transport {
  return async (url, body) => {
    try {
      const response = await request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...correlationHeader() },
        body: JSON.stringify(body),
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
