import { randomUUID } from 'node:crypto'
import { Redis } from 'ioredis'
import { request } from 'undici'
import { z } from 'zod'
import type { RatePlan } from './supplier-control.js'
import type { System } from './system.js'
import { waitFor } from './waits.js'

/**
 * Pembangun data uji: membawa pemesanan ke keadaan tertentu LEWAT ALUR
 * SUNGGUHAN — HTTP ke booking-service dan payment-service, notifikasi bertanda
 * tangan ke webhook — bukan dengan menulis baris ke basis data.
 *
 * Keadaan yang ditulis langsung ke basis data melompati persis hal yang ingin
 * dibuktikan: outbox, konsumsi idempoten, dan transisi yang dijaga domain.
 * Sama dengan aturan Step 16–19 untuk uji unit (builders.ts), di tingkat
 * sistem.
 */

export interface Money {
  readonly amountMinor: number
  readonly currency: string
}

export interface Journey {
  readonly userId: string
  readonly idempotencyKey: string
  readonly bookingId: string
  readonly stay: { readonly checkIn: string; readonly checkOut: string }
  readonly ratePlan: RatePlan
  readonly total: Money
}

export interface HttpAnswer {
  readonly status: number
  readonly body: Record<string, unknown>
}

/** Kapasitas slot yang dilaporkan "hasil pencarian" — cukup longgar untuk satu uji. */
const UNITS_LEFT = 20

/** Kunci penghitung perjalanan di Redis uji — dibagikan SEMUA berkas uji. */
const STAY_COUNTER_KEY = 'saga-it:stay-counter'

/**
 * Tanggal menginap yang berbeda untuk setiap perjalanan, di SELURUH berkas uji.
 *
 * Slot hold lokal dikunci rate plan + tanggal, dan persediaan mock-supplier
 * dihitung per malam — dua perjalanan dengan tanggal yang sama berbagi kamar,
 * dan uji yang gagal SOLD_OUT karena sisa uji lain adalah ketergantungan
 * tersembunyi.
 *
 * Penghitungnya INCR di Redis, bukan penghitung di memori. Versi sebelumnya
 * menggeser tanggal dengan `process.pid % 97`: berkas uji berjalan di proses
 * pekerja yang berbeda, dan dua pid dapat menghasilkan tanggal yang sama.
 * INCR atomik di satu server yang dipakai semua pekerja; setiap perjalanan
 * mendapat bilangan yang tidak pernah dipakai perjalanan lain.
 */
export async function nextStay(system: System): Promise<{ checkIn: string; checkOut: string }> {
  const redis = new Redis(system.infra.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 })
  await redis.connect()
  try {
    const counter = await redis.incr(STAY_COUNTER_KEY)
    // Tiga hari per perjalanan: dua malam menginap ditambah satu malam jeda.
    const offsetDays = 400 + counter * 3
    const start = new Date(Date.UTC(2027, 0, 1) + offsetDays * 86_400_000)
    const end = new Date(start.getTime() + 2 * 86_400_000)
    return { checkIn: iso(start), checkOut: iso(end) }
  } finally {
    redis.disconnect()
  }
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10)
}

export async function call(
  method: 'GET' | 'POST',
  url: string,
  options: { readonly userId?: string; readonly body?: unknown } = {},
): Promise<HttpAnswer> {
  const response = await request(url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(options.userId === undefined ? {} : { 'x-tbe-user-id': options.userId }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  const text = await response.body.text()
  const parsed: unknown = text === '' ? {} : JSON.parse(text)
  const body =
    typeof parsed === 'object' && parsed !== null ? Object.fromEntries(Object.entries(parsed)) : {}
  return { status: response.statusCode, body }
}

export function priceCheckBody(journey: {
  readonly idempotencyKey: string
  readonly ratePlan: RatePlan
  readonly stay: { readonly checkIn: string; readonly checkOut: string }
  readonly displayed: Money
}) {
  return {
    idempotencyKey: journey.idempotencyKey,
    supplier: 'SKY',
    propertyId: journey.ratePlan.propertyId,
    city: journey.ratePlan.city,
    ratePlanRef: journey.ratePlan.ratePlanRef,
    // Ketentuan tawaran sebagai bahan e-voucher (Step 23). Uji saga tidak
    // memeriksanya; nilainya cukup sah.
    offer: {
      roomTypeName: 'Kamar Uji',
      ratePlanName: 'Tarif Uji',
      breakfastIncluded: false,
      cancellationPolicy: { refundable: false },
    },
    checkIn: journey.stay.checkIn,
    checkOut: journey.stay.checkOut,
    guest: { fullName: 'Budi Santoso', email: 'budi@example.test', count: 2 },
    displayedTotal: journey.displayed,
  }
}

/**
 * Pemesanan dengan harga terverifikasi (PRICE_CHECKED).
 *
 * Harga yang "dilihat pengguna" sengaja tidak diketahui uji: price check
 * pertama menjawab `changed` dengan harga jual sesungguhnya, lalu pengguna
 * menyetujuinya — alur US-02 yang sama dengan produksi, bukan harga yang
 * dihitung ulang di uji.
 */
export async function priceChecked(system: System): Promise<Journey> {
  const userId = randomUUID()
  const idempotencyKey = `saga-it-${randomUUID()}`
  const stay = await nextStay(system)
  const ratePlan = await system.supplier.findSkyRatePlan(stay)
  const base = `${system.booking.url}/bookings`

  const first = await call('POST', `${base}/price-check`, {
    userId,
    body: priceCheckBody({
      idempotencyKey,
      ratePlan,
      stay,
      displayed: { amountMinor: 1, currency: 'IDR' },
    }),
  })
  expectOk(first, 'price check pertama')
  const bookingId = String(data(first).id)

  const total = await acceptPrice(system, userId, bookingId)

  return { userId, idempotencyKey, bookingId, stay, ratePlan, total }
}

/**
 * Pengguna menyetujui harga baru, lalu price check ulang berjalan. Mengembalikan
 * harga jual yang terverifikasi — nilai yang kelak boleh ditagih.
 */
export async function acceptPrice(
  system: System,
  userId: string,
  bookingId: string,
): Promise<Money> {
  const accepted = await call('POST', `${system.booking.url}/bookings/price-check/accept`, {
    userId,
    body: { bookingId },
  })
  expectOk(accepted, 'persetujuan harga')
  const verified = verifiedSchema.safeParse(data(accepted))
  if (!verified.success) {
    throw new Error(`harga belum terverifikasi setelah disetujui: ${JSON.stringify(accepted.body)}`)
  }
  return verified.data.price.total
}

const moneySchema = z.object({ amountMinor: z.number().int(), currency: z.string() })

const verifiedSchema = z.object({
  priceCheck: z.object({ outcome: z.literal('unchanged') }),
  price: z.object({ total: moneySchema }),
})

/** HELD: hold lokal dan hold supplier sama-sama terambil. */
export async function held(system: System, journey?: Journey): Promise<Journey> {
  const current = journey ?? (await priceChecked(system))
  const answer = await placeHold(system, current)
  expectOk(answer, 'hold')
  return current
}

export async function placeHold(system: System, journey: Journey): Promise<HttpAnswer> {
  return await call('POST', `${system.booking.url}/bookings/hold`, {
    userId: journey.userId,
    body: { bookingId: journey.bookingId, unitsLeft: UNITS_LEFT },
  })
}

/**
 * Niat pembayaran di payment-service. Menunggu sampai payment-service
 * MENGETAHUI nilai yang boleh ditagih — dari `booking.created` yang tiba lewat
 * outbox dan Kafka. Selama belum tiba, jawabannya 409 `amount_unknown`, dan
 * itu yang ditunggu, bukan jeda tetap.
 */
export async function paymentIntent(system: System, journey: Journey): Promise<string> {
  const answer = await waitFor(
    `payment-service menerima niat pembayaran ${journey.bookingId}`,
    async () =>
      await call('POST', `${system.payment.url}/internal/payments`, {
        body: {
          bookingId: journey.bookingId,
          idempotencyKey: `pay-${journey.bookingId}`,
          amount: journey.total,
        },
      }),
    (reply) => reply.status === 201 || reply.status === 200,
  )
  return z.object({ payment: z.object({ id: z.string() }) }).parse(data(answer)).payment.id
}

/** Membayar lewat notifikasi Midtrans bertanda tangan sah. */
export async function pay(
  system: System,
  journey: Journey,
  status: 'settlement' | 'deny' = 'settlement',
): Promise<string> {
  const paymentId = await paymentIntent(system, journey)
  await settle(system, paymentId, status)
  return paymentId
}

/** Notifikasi Midtrans untuk niat pembayaran yang sudah ada. */
export async function settle(
  system: System,
  paymentId: string,
  status: 'settlement' | 'deny' = 'settlement',
): Promise<void> {
  const code = await system.midtrans.notify(system.payment.url, { orderId: paymentId, status })
  if (code !== 200) throw new Error(`webhook Midtrans dijawab ${String(code)}`)
}

/** Bentuk GET /bookings/:id/status, diurai — bukan dipercaya — dari JSON. */
const statusSchema = z.object({
  status: z.string(),
  isFinal: z.boolean(),
  refund: z.string().nullable(),
  failureReason: z.string().nullable(),
  supplierRef: z.string().nullable(),
  saga: z.object({ phase: z.string(), step: z.string() }).nullable(),
})

export type StatusView = z.infer<typeof statusSchema>

export async function bookingStatus(system: System, journey: Journey): Promise<StatusView> {
  const answer = await call('GET', `${system.booking.url}/bookings/${journey.bookingId}/status`, {
    userId: journey.userId,
  })
  expectOk(answer, 'status pemesanan')
  return statusSchema.parse(data(answer))
}

/** Menunggu pemesanan mencapai status tertentu, lewat API status (FR-23). */
export async function waitForStatus(
  system: System,
  journey: Journey,
  status: string,
  timeoutMs = 60_000,
): Promise<StatusView> {
  return await waitFor(
    `pemesanan ${journey.bookingId} mencapai ${status}`,
    async () => await bookingStatus(system, journey),
    (view) => view.status === status,
    timeoutMs,
  )
}

export function data(answer: HttpAnswer): Record<string, unknown> {
  const inner = answer.body.data
  if (typeof inner !== 'object' || inner === null) {
    throw new Error(`jawaban tanpa data (${String(answer.status)}): ${JSON.stringify(answer.body)}`)
  }
  return Object.fromEntries(Object.entries(inner))
}

function expectOk(answer: HttpAnswer, label: string): void {
  if (answer.status >= 400) {
    throw new Error(`${label} gagal (${String(answer.status)}): ${JSON.stringify(answer.body)}`)
  }
}
