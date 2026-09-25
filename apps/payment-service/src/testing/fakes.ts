import { RETRY_COUNT_HEADER, type RabbitPublisher } from '@tbe/messaging'
import { money, type Money } from '@tbe/money'
import { createLogger, type Logger } from '@tbe/shared-kernel'
import { createPayment, type Payment, type SettledPayment } from '../domain/payment.js'
import type {
  ChargeRequest,
  ChargeResult,
  Clock,
  GatewayRefundRequest,
  GatewayRefundResult,
  IdFactory,
  NotificationSignature,
  PayableAmount,
  PayableAmounts,
  PaymentDeps,
  PaymentEvents,
  PaymentGateway,
  SignatureVerifier,
} from '../application/ports.js'
import {
  memoryPaymentRepository,
  memoryWebhookLedger,
  racyPaymentRepository,
  racyWebhookLedger,
  type RecordingLedger,
  type RecordingRepository,
} from './stores.js'

/**
 * Palsuan penyimpanan tinggal di stores.ts dan diteruskan dari sini, supaya
 * berkas uji cukup mengimpor dari satu tempat.
 */
export {
  memoryPaymentRepository,
  memoryWebhookLedger,
  racyPaymentRepository,
  racyWebhookLedger,
  type RecordingLedger,
  type RecordingRepository,
}

/**
 * Perkakas uji.
 *
 * Docker mati sejak Step 05, jadi tidak ada Postgres. Palsuan di berkas ini
 * karena itu tidak boleh sekadar mencatat panggilan — ia harus MENIRU SIFAT
 * yang diandalkan kode sungguhan, dan yang paling diandalkan di service ini
 * adalah satu hal: **batasan UNIK menolak penyisipan kedua.**
 *
 * Untuk setiap palsuan yang menirunya, ada palsuan TANDINGAN yang justru
 * memakai pola "periksa dulu baru tulis" — [racyWebhookLedger] dan
 * [racyPaymentRepository]. Keduanya dipakai uji untuk membuktikan bahwa uji
 * balapan tidak hampa: uji yang sama harus GAGAL pada palsuan tandingan. Tanpa
 * itu, "sepuluh webhook serentak menghasilkan satu efek" bisa lulus hanya karena
 * palsuannya tidak pernah benar-benar menghadapi balapan.
 *
 * Yang tetap TIDAK dibuktikan di sini: bahwa Postgres sungguhan menegakkannya.
 * Itu pekerjaan uji integrasi Step 20, dan dicatat apa adanya di README.
 */

export const TEST_BOOKING_ID = '22222222-2222-4222-8222-222222222222'
export const TEST_PAYMENT_ID = '11111111-1111-4111-8111-111111111111'
export const TEST_AMOUNT: Money = money(1_250_000, 'IDR')

export interface RecordedEvent {
  readonly type: 'succeeded' | 'failed' | 'refunded'
  readonly paymentId: string
  readonly bookingId: string
  readonly amount?: Money | undefined
  readonly reason?: string | undefined
}

export interface RecordingEvents extends PaymentEvents {
  readonly published: RecordedEvent[]
}

export function recordingEvents(effects?: string[]): RecordingEvents {
  const published: RecordedEvent[] = []
  const log = effects ?? []

  return {
    published,

    async succeeded(input) {
      published.push({ type: 'succeeded', ...input })
      log.push(`event:payment.succeeded:${input.paymentId}`)
      await Promise.resolve()
    },

    async failed(input) {
      published.push({ type: 'failed', ...input })
      log.push(`event:payment.failed:${input.paymentId}`)
      await Promise.resolve()
    },

    async refunded(input) {
      published.push({ type: 'refunded', ...input })
      log.push(`event:payment.refunded:${input.refundId}`)
      await Promise.resolve()
    },
  }
}

export interface RecordingPayables extends PayableAmounts {
  readonly rows: Map<string, PayableAmount>
}

export function memoryPayableAmounts(seed?: PayableAmount): RecordingPayables {
  const rows = new Map<string, PayableAmount>()

  if (seed !== undefined) rows.set(seed.bookingId, seed)

  return {
    rows,

    async find(bookingId) {
      await Promise.resolve()

      return rows.get(bookingId)
    },

    async record(entry) {
      const existing = rows.get(entry.bookingId)

      // Peristiwa yang lebih lama tidak menimpa yang lebih baru. Tanpa ini,
      // booking.created yang tiba terlambat memutar harga kembali ke nilai yang
      // sudah tidak disetujui pengguna.
      if (existing === undefined || existing.observedAt <= entry.observedAt) {
        rows.set(entry.bookingId, entry)
      }

      await Promise.resolve()
    },
  }
}

/** Verifikator yang menerima apa pun. Tidak membutuhkan kunci sama sekali. */
export function acceptingVerifier(): SignatureVerifier {
  return { isValid: () => true }
}

export function rejectingVerifier(): SignatureVerifier {
  return { isValid: () => false }
}

/**
 * Verifikator yang menerima hanya satu nilai tertentu.
 *
 * Dipakai membuktikan bahwa verifikasi memang dijalankan atas bahan yang benar,
 * bukan hanya dipanggil.
 */
export function verifierAccepting(expected: string): SignatureVerifier {
  return { isValid: (input: NotificationSignature) => input.signatureKey === expected }
}

export interface ScriptedGateway extends PaymentGateway {
  readonly charges: ChargeRequest[]
  readonly refunds: GatewayRefundRequest[]
}

export interface GatewayScript {
  readonly charge?: readonly ChargeResult[] | undefined
  readonly refund?: readonly GatewayRefundResult[] | undefined
}

export function scriptedGateway(script: GatewayScript = {}, effects?: string[]): ScriptedGateway {
  const charges: ChargeRequest[] = []
  const refunds: GatewayRefundRequest[] = []
  const log = effects ?? []

  function reply<T>(replies: readonly T[] | undefined, index: number, fallback: T): T {
    if (replies === undefined || replies.length === 0) return fallback

    return replies[Math.min(index, replies.length - 1)] ?? fallback
  }

  return {
    charges,
    refunds,

    async charge(request) {
      const index = charges.length
      charges.push(request)
      log.push(`gateway:charge:${request.paymentId}`)
      await Promise.resolve()

      return reply<ChargeResult>(script.charge, index, {
        kind: 'created',
        redirectUrl: 'https://app.sandbox.midtrans.example/snap/v1/redirect',
        providerRef: `snap-${request.paymentId}`,
      })
    },

    async refund(request) {
      const index = refunds.length
      refunds.push(request)
      log.push(`gateway:refund:${request.requestId}`)
      await Promise.resolve()

      return reply<GatewayRefundResult>(script.refund, index, {
        kind: 'refunded',
        providerRef: `refund-${request.requestId}`,
      })
    },
  }
}

export interface RecordedPublish {
  readonly exchange: string
  readonly routingKey: string
  readonly retryCount: string | number | undefined
}

/**
 * Penerbit RabbitMQ palsu.
 *
 * Ditulis di sini alih-alih diimpor dari @tbe/messaging: perkakas uji package
 * itu tidak ikut ter-build dan tidak diekspor. Yang dipenuhi adalah port
 * [RabbitPublisher] yang sama dengan yang dipakai pembungkus consumer
 * sungguhan, sehingga uji di messaging/ memakai pembungkus yang sesungguhnya —
 * bukan tiruan kebijakan percobaan ulang yang dibuat sendiri.
 */
export function recordingPublisher(): RabbitPublisher & {
  readonly published: RecordedPublish[]
} {
  const published: RecordedPublish[] = []

  return {
    published,

    async publish(exchange, routingKey, _content, options) {
      published.push({
        exchange,
        routingKey,
        retryCount: options.headers[RETRY_COUNT_HEADER],
      })
      await Promise.resolve()
    },
  }
}

export function fixedClock(iso = '2026-09-25T02:00:00.000Z'): Clock {
  return { now: () => new Date(iso) }
}

/** Pengenal berurutan; membuat uji dapat menyebut id yang akan dihasilkan. */
export function sequentialIds(prefix = 'generated'): IdFactory & { readonly issued: string[] } {
  const issued: string[] = []

  return {
    issued,
    next() {
      const id = `${prefix}-${String(issued.length + 1)}`
      issued.push(id)

      return id
    },
  }
}

export interface LoggedLine {
  readonly level: string
  readonly msg: string
  readonly [key: string]: unknown
}

/**
 * Tingkat log tercatat sebagai LABEL, bukan angka.
 *
 * Pino menulis angka secara bawaan; shared-kernel memasang
 * `formatters.level` yang menggantinya dengan labelnya. Nilai di bawah
 * mengikuti keluaran sungguhan — dan perbedaan itu baru terlihat karena uji
 * memakai logger sungguhan. Palsuan logger buatan sendiri akan lulus terhadap
 * angka yang tidak pernah ada di keluaran mana pun.
 */
export const LOG_LEVELS = { info: 'info', warn: 'warn', error: 'error' } as const

/**
 * Logger SUNGGUHAN dengan tujuan penulisan yang ditangkap.
 *
 * Bukan objek palsu berisi fungsi kosong: tingkat log adalah bagian dari
 * Definisi Selesai ("dicatat sebagai peringatan keamanan", "galat tingkat error,
 * bukan sekadar peringatan"), dan tingkat yang diuji harus tingkat yang
 * benar-benar dihasilkan pino — bukan tingkat yang dicatat palsuan kita sendiri.
 */
export function recordingLogger(): { logger: Logger; lines: LoggedLine[] } {
  const lines: LoggedLine[] = []

  const logger = createLogger({
    serviceName: 'payment-service-test',
    level: 'debug',
    destination: {
      write(chunk: string): void {
        const parsed: unknown = JSON.parse(chunk)

        if (typeof parsed === 'object' && parsed !== null) lines.push(parsed as LoggedLine)
      },
    },
  })

  return { logger, lines }
}

export interface Harness {
  readonly deps: PaymentDeps
  readonly payments: RecordingRepository
  readonly ledger: RecordingLedger
  readonly payables: RecordingPayables
  readonly gateway: ScriptedGateway
  readonly events: RecordingEvents
  readonly ids: IdFactory & { readonly issued: string[] }
  readonly lines: LoggedLine[]
  /** Urutan seluruh efek: penulisan basis data dan penerbitan peristiwa. */
  readonly effects: string[]
}

export interface HarnessOptions {
  readonly ledger?: RecordingLedger | undefined
  readonly payments?: RecordingRepository | undefined
  readonly verifier?: SignatureVerifier | undefined
  readonly gateway?: ScriptedGateway | undefined
  readonly payable?: PayableAmount | undefined
  /** true memakai palsuan "periksa dulu baru tulis" untuk keduanya. */
  readonly racy?: boolean | undefined
}

export function harness(options: HarnessOptions = {}): Harness {
  const effects: string[] = []
  const racy = options.racy ?? false

  const payments =
    options.payments ?? (racy ? racyPaymentRepository(effects) : memoryPaymentRepository(effects))
  const ledger = options.ledger ?? (racy ? racyWebhookLedger() : memoryWebhookLedger())
  const events = recordingEvents(effects)
  const gateway = options.gateway ?? scriptedGateway({}, effects)
  const ids = sequentialIds()
  const { logger, lines } = recordingLogger()

  const payables = memoryPayableAmounts(
    options.payable ?? {
      bookingId: TEST_BOOKING_ID,
      amount: TEST_AMOUNT,
      source: 'booking.created',
      observedAt: new Date('2026-09-25T01:00:00.000Z'),
    },
  )

  return {
    payments,
    ledger,
    payables,
    gateway,
    events,
    ids,
    lines,
    effects,
    deps: {
      payments,
      ledger,
      payables,
      gateway,
      events,
      verifier: options.verifier ?? acceptingVerifier(),
      clock: fixedClock(),
      ids,
      logger,
    },
  }
}

/** Pembayaran PENDING yang sudah tersimpan di repository. */
export async function givenPendingPayment(
  world: Harness,
  overrides: { readonly amount?: Money; readonly id?: string } = {},
): Promise<Payment> {
  const payment = createPayment({
    id: overrides.id ?? TEST_PAYMENT_ID,
    bookingId: TEST_BOOKING_ID,
    amount: overrides.amount ?? TEST_AMOUNT,
    idempotencyKey: 'bkg-1:attempt-1',
  })

  await world.payments.insert(payment)
  forgetSetupEffects(world)

  return payment
}

/** Pembayaran SUCCEEDED yang sudah tersimpan, siap direfund. */
export async function givenSucceededPayment(world: Harness): Promise<SettledPayment> {
  const pending = await givenPendingPayment(world)

  const settled: SettledPayment = {
    id: pending.id,
    bookingId: pending.bookingId,
    amount: pending.amount,
    idempotencyKey: pending.idempotencyKey,
    status: 'SUCCEEDED',
    gatewayRef: 'midtrans-tx-1',
    refunds: [],
  }

  await world.payments.update(settled)
  forgetSetupEffects(world)

  return settled
}

/**
 * Melupakan efek yang dihasilkan PERSIAPAN uji.
 *
 * Tanpa ini, setiap pemeriksaan urutan efek harus melewati penulisan yang dibuat
 * oleh persiapan, dan uji urutan yang dimulai dengan "lewati dua elemen pertama"
 * berhenti menjelaskan apa yang sebenarnya diperiksa.
 *
 * Lariknya diambil ke variabel lokal lebih dulu, bukan diubah lewat `world`.
 * Menulis `world.effects.length = 0` adalah mutasi atas properti argumen —
 * dilarang aturan `no-param-reassign` (CONVENTIONS.md bagian 4) — sementara
 * mengosongkan larik yang memang dimiliki harness bukan mutasi yang dimaksud
 * aturan itu.
 */
function forgetSetupEffects(world: Harness): void {
  const { effects, payments } = world

  effects.length = 0
  payments.writes.length = 0
}
