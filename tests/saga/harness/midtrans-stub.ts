import { createHash, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { request } from 'undici'

/**
 * Pengganti SANDBOX MIDTRANS di tingkat HTTP.
 *
 * Satu-satunya tiruan di rangkaian uji ini, dan alasannya berbeda dari
 * larangan NFR-19. Yang dilarang adalah meniru INFRASTRUKTUR kita — Postgres,
 * Redis, Kafka, RabbitMQ — karena tiruannya tidak punya balapan, partisi, dan
 * kegagalan koneksi. Midtrans adalah pihak ketiga: sandboxnya tidak dapat
 * diperintah gagal sesuai kehendak (README payment-service), tidak dapat
 * dijangkau dari CI tanpa kredensial, dan uji yang bergantung padanya akan
 * gagal setiap kali internet atau sandboxnya bermasalah.
 *
 * Yang TETAP sungguhan: adapter `midtrans-gateway.ts` di payment-service, yang
 * berbicara HTTP ke server ini persis seperti ke Midtrans, dan verifikasi tanda
 * tangan notifikasinya — server ini menandatangani notifikasi dengan rumus
 * yang sama, dan tanda tangan yang salah ditolak payment-service.
 */

export type RefundBehavior = 'accept' | 'unavailable' | 'reject'

export interface Charge {
  readonly orderId: string
  readonly grossAmount: number
  readonly bookingId: string
}

export interface RefundCall {
  readonly gatewayRef: string
  /** Pembayaran kita (order_id) yang dimiliki transaksi itu, bila dikenal. */
  readonly orderId: string | undefined
  readonly refundKey: string
  readonly answeredWith: RefundBehavior
}

export interface Notification {
  readonly orderId: string
  readonly status: 'settlement' | 'deny'
  /** Pengenal transaksi Midtrans; sama = notifikasi yang sama dikirim ulang. */
  readonly transactionId?: string | undefined
}

export interface MidtransStub {
  readonly url: string
  readonly serverKey: string
  readonly charges: ReadonlyMap<string, Charge>
  readonly refunds: readonly RefundCall[]
  /**
   * Jawaban untuk refund berikutnya. Dengan `orderId`, hanya untuk pembayaran
   * itu — dua skenario yang berjalan bersamaan dapat meminta jawaban berbeda.
   */
  setRefundBehavior(behavior: RefundBehavior, orderId?: string): void
  /** Mengirim notifikasi bertanda tangan sah ke payment-service. Mengembalikan status HTTP. */
  notify(paymentServiceUrl: string, notification: Notification): Promise<number>
  reset(): void
  close(): Promise<void>
}

const STATUS_CODES = { settlement: '200', deny: '202' } as const

export async function startMidtransStub(): Promise<MidtransStub> {
  const serverKey = `SB-Mid-server-saga-it-${randomUUID()}`
  const charges = new Map<string, Charge>()
  const refunds: RefundCall[] = []
  /** transaction_id Midtrans → order_id kita, dicatat saat notifikasi dikirim. */
  const orderOfTransaction = new Map<string, string>()
  const behaviorFor = new Map<string, RefundBehavior>()
  let refundBehavior: RefundBehavior = 'accept'

  const server = createServer((req, res) => {
    void readJson(req).then((body) => {
      if (req.method === 'POST' && req.url === '/snap/v1/transactions') {
        recordCharge(charges, body)
        reply(res, 201, { token: `snap-${randomUUID()}`, redirect_url: 'https://stub.invalid/pay' })
        return
      }

      const refund = /^\/v2\/([^/]+)\/refund$/.exec(req.url ?? '')
      if (req.method === 'POST' && refund !== null) {
        const refundKey = typeof body.refund_key === 'string' ? body.refund_key : ''
        const gatewayRef = refund[1] ?? ''
        const orderId = orderOfTransaction.get(gatewayRef)
        const behavior =
          (orderId === undefined ? undefined : behaviorFor.get(orderId)) ?? refundBehavior
        refunds.push({ gatewayRef, orderId, refundKey, answeredWith: behavior })
        answerRefund(res, behavior, refundKey)
        return
      }

      reply(res, 404, { status_code: '404' })
    })
  })

  const url = await listen(server)

  return {
    url,
    serverKey,
    charges,
    refunds,
    setRefundBehavior(behavior, orderId) {
      if (orderId === undefined) refundBehavior = behavior
      else behaviorFor.set(orderId, behavior)
    },
    async notify(paymentServiceUrl, notification) {
      const charge = charges.get(notification.orderId)
      if (charge === undefined) throw new Error(`tidak ada tagihan untuk ${notification.orderId}`)
      const transactionId = notification.transactionId ?? randomUUID()
      orderOfTransaction.set(transactionId, notification.orderId)
      return await sendNotification(paymentServiceUrl, serverKey, charge, {
        ...notification,
        transactionId,
      })
    },
    reset() {
      behaviorFor.clear()
      refundBehavior = 'accept'
    },
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
    },
  }
}

function recordCharge(charges: Map<string, Charge>, body: Record<string, unknown>): void {
  const details = body.transaction_details
  if (typeof details !== 'object' || details === null) return
  const orderId = 'order_id' in details ? String(details.order_id) : ''
  const grossAmount = 'gross_amount' in details ? Number(details.gross_amount) : Number.NaN
  charges.set(orderId, { orderId, grossAmount, bookingId: String(body.custom_field1) })
}

function answerRefund(res: ServerResponse, behavior: RefundBehavior, refundKey: string): void {
  if (behavior === 'unavailable') {
    reply(res, 503, { status_code: '503', status_message: 'sandbox sedang tidak melayani' })
    return
  }
  if (behavior === 'reject') {
    reply(res, 200, { status_code: '412', status_message: 'transaksi tidak dapat direfund' })
    return
  }
  reply(res, 200, { status_code: '200', refund_key: refundKey })
}

async function sendNotification(
  paymentServiceUrl: string,
  serverKey: string,
  charge: Charge,
  notification: Notification,
): Promise<number> {
  // IDR bereksponen 0; Midtrans tetap menulis dua desimal.
  const grossAmount = `${String(charge.grossAmount)}.00`
  const statusCode = STATUS_CODES[notification.status]
  const signature = createHash('sha512')
    .update(`${charge.orderId}${statusCode}${grossAmount}${serverKey}`, 'utf8')
    .digest('hex')

  const response = await request(`${paymentServiceUrl}/webhooks/midtrans`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      order_id: charge.orderId,
      transaction_id: notification.transactionId ?? randomUUID(),
      transaction_status: notification.status,
      fraud_status: 'accept',
      status_code: statusCode,
      gross_amount: grossAmount,
      currency: 'IDR',
      signature_key: signature,
    }),
  })
  await response.body.dump()
  return response.statusCode
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array))
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return {}
  const parsed: unknown = JSON.parse(text)
  return typeof parsed === 'object' && parsed !== null
    ? Object.fromEntries(Object.entries(parsed))
    : {}
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
}
