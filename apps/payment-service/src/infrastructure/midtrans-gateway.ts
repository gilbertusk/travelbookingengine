import type { Money } from '@tbe/money'
import type { Logger } from '@tbe/shared-kernel'
import { request } from 'undici'
import { z } from 'zod'
import type {
  ChargeRequest,
  ChargeResult,
  GatewayRefundRequest,
  GatewayRefundResult,
  PaymentGateway,
} from '../application/ports.js'

/**
 * Adapter Midtrans. SATU-SATUNYA tempat sandbox Midtrans dihubungi.
 *
 * Batas ini bukan formalitas: sandbox tidak dapat diperintah gagal sesuai
 * kehendak, jadi chaos test Step 28 menyuntikkan kegagalan di port
 * [PaymentGateway] — bukan di jaringan. Satu panggilan Midtrans dari luar berkas
 * ini berarti ada jalur yang tidak dapat disuntik, dan jalur yang tidak dapat
 * disuntik adalah jalur yang tidak pernah diuji terhadap kegagalan.
 *
 * Tiga hal dinormalkan di sini dan tidak boleh bocor ke atas:
 *
 * 1. **Nilai uang menjadi string desimal.** Midtrans menerima `gross_amount`
 *    sebagai angka dalam satuan UTAMA. Untuk IDR yang bereksponen 0, itu berarti
 *    `amountMinor` apa adanya; untuk USD, ia harus dibagi seratus — dan
 *    pembagian itu dilakukan atas DIGIT, bukan dengan `/ 100`, supaya tidak ada
 *    pecahan biner yang menyentuh nilai yang ditagih.
 * 2. **Kegagalan menjadi tiga jawaban.** `rejected` permanen, `unavailable`
 *    sementara. Perbedaannya yang menentukan apakah perintah refund dicoba ulang
 *    atau masuk dead letter, jadi ia tidak boleh disimpulkan dari pesan galat.
 * 3. **Respons divalidasi.** Penyedia adalah sumber data yang tidak tepercaya,
 *    sama seperti supplier (CONVENTIONS.md bagian 6).
 */

const SNAP_PATH = '/snap/v1/transactions'
const REFUND_TIMEOUT_MS = 10_000
const CHARGE_TIMEOUT_MS = 10_000

const snapResponse = z.object({
  token: z.string().min(1),
  redirect_url: z.string().min(1),
})

const refundResponse = z.object({
  status_code: z.string(),
  refund_key: z.string().optional(),
  transaction_id: z.string().optional(),
})

export interface MidtransOptions {
  /** Basis URL Snap, mis. https://app.sandbox.midtrans.com */
  readonly snapBaseUrl: string
  /** Basis URL API inti, mis. https://api.sandbox.midtrans.com */
  readonly apiBaseUrl: string
  /** Dibaca config.ts dari env. Tidak pernah dicatat maupun disimpan. */
  readonly serverKey: string
  readonly logger: Logger
}

export function createMidtransGateway(options: MidtransOptions): PaymentGateway {
  // Midtrans memakai Basic auth dengan server key sebagai nama pengguna dan kata
  // sandi kosong. Disusun sekali di sini, bukan pada setiap panggilan.
  const authorization = `Basic ${Buffer.from(`${options.serverKey}:`, 'utf8').toString('base64')}`

  return {
    charge: async (input) => await charge(options, authorization, input),
    refund: async (input) => await refund(options, authorization, input),
  }
}

async function charge(
  options: MidtransOptions,
  authorization: string,
  input: ChargeRequest,
): Promise<ChargeResult> {
  try {
    const response = await request(`${options.snapBaseUrl}${SNAP_PATH}`, {
      method: 'POST',
      headersTimeout: CHARGE_TIMEOUT_MS,
      bodyTimeout: CHARGE_TIMEOUT_MS,
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({
        transaction_details: {
          // order_id = id pembayaran kita. Inilah yang membuat penagihan
          // idempoten di sisi penyedia: permintaan ulang memakai order_id yang
          // sama, jadi tidak ada transaksi kedua yang terbentuk.
          order_id: input.paymentId,
          gross_amount: majorUnits(input.amount),
        },
        custom_field1: input.bookingId,
      }),
    })

    return interpretCharge(response.statusCode, await response.body.json(), options.logger)
  } catch (error) {
    // Timeout dan koneksi gagal. Dapat berubah dengan dicoba ulang, dan karena
    // itu TIDAK boleh dilaporkan sebagai penolakan.
    options.logger.warn({ err: error, paymentId: input.paymentId }, 'Midtrans tidak terjangkau')

    return { kind: 'unavailable' }
  }
}

async function refund(
  options: MidtransOptions,
  authorization: string,
  input: GatewayRefundRequest,
): Promise<GatewayRefundResult> {
  try {
    const response = await request(
      `${options.apiBaseUrl}/v2/${encodeURIComponent(input.gatewayRef)}/refund`,
      {
        method: 'POST',
        headersTimeout: REFUND_TIMEOUT_MS,
        bodyTimeout: REFUND_TIMEOUT_MS,
        headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify({
          // Kunci idempotensi Midtrans sendiri. Meneruskan pengenal permintaan
          // kita berarti percobaan ulang kita tidak menghasilkan refund kedua di
          // sisi sana — dan batasan UNIK kita tidak dapat melindungi apa pun yang
          // sudah terjadi di sistem orang lain.
          refund_key: input.requestId,
          amount: majorUnits(input.amount),
          reason: input.reason,
        }),
      },
    )

    return interpretRefund(response.statusCode, await response.body.json(), options.logger)
  } catch (error) {
    options.logger.warn(
      { err: error, requestId: input.requestId },
      'Midtrans tidak terjangkau saat refund',
    )

    return { kind: 'unavailable' }
  }
}

function interpretCharge(status: number, body: unknown, logger: Logger): ChargeResult {
  if (status >= 500) return { kind: 'unavailable' }

  const parsed = snapResponse.safeParse(body)

  if (!parsed.success) {
    // Jawaban 2xx yang bentuknya tidak dikenal diperlakukan sebagai penolakan,
    // bukan keberhasilan. Melanjutkan tanpa tautan pembayaran berarti pengguna
    // diarahkan ke halaman yang tidak ada.
    logger.warn({ status }, 'respons Snap Midtrans tidak sesuai bentuk yang dikenal')

    return { kind: 'rejected', reason: `respons tidak dikenal (${String(status)})` }
  }

  return {
    kind: 'created',
    redirectUrl: parsed.data.redirect_url,
    providerRef: parsed.data.token,
  }
}

function interpretRefund(status: number, body: unknown, logger: Logger): GatewayRefundResult {
  if (status >= 500) return { kind: 'unavailable' }

  const parsed = refundResponse.safeParse(body)

  if (!parsed.success) {
    logger.error({ status }, 'respons refund Midtrans tidak sesuai bentuk yang dikenal')

    return { kind: 'unavailable' }
  }

  // 200 dan 201 keduanya berarti refund diterima; 412 berarti transaksinya tidak
  // dapat direfund lagi, dan itu permanen.
  if (parsed.data.status_code === '200' || parsed.data.status_code === '201') {
    return {
      kind: 'refunded',
      providerRef: parsed.data.refund_key ?? parsed.data.transaction_id ?? 'tanpa-rujukan',
    }
  }

  return { kind: 'rejected', reason: `status ${parsed.data.status_code}` }
}

/**
 * Nilai dalam satuan utama, sebagai bilangan.
 *
 * Dihitung atas DIGIT, bukan dengan `amountMinor / 100`. Pembagian biner pada
 * nilai tertentu menghasilkan angka seperti 10.229999999999999, dan angka itu
 * ikut masuk ke bahan tanda tangan serta ke nilai yang ditagih.
 *
 * IDR bereksponen 0, jadi satuan utamanya sama dengan satuan terkecilnya dan
 * tidak ada pembagian sama sekali. USD bereksponen 2.
 */
function majorUnits(amount: Money): number {
  if (amount.currency === 'IDR') return amount.amountMinor

  const digits = String(Math.abs(amount.amountMinor)).padStart(3, '0')
  const whole = digits.slice(0, -2)
  const fraction = digits.slice(-2)
  const sign = amount.amountMinor < 0 ? '-' : ''

  return Number(`${sign}${whole}.${fraction}`)
}
