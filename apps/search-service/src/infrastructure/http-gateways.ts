import { request } from 'undici'
import {
  searchResultSchema,
  supplierCodeSchema,
  type SupplierSearchResult,
} from '@tbe/supplier-adapters'
import { moneySchema } from '@tbe/money'
import { z } from 'zod'
import type {
  PricedItem,
  PricingGateway,
  PricingRequestItem,
  SupplierGateway,
  SupplierSearchCriteria,
  SupplierStatus,
} from '../application/ports.js'

/**
 * Pintu ke supplier-service dan pricing-service.
 *
 * Keduanya service internal, tetapi jawabannya tetap DIVALIDASI. "Internal"
 * bukan jaminan: service yang satu dapat dikerahkan ulang dengan bentuk
 * jawaban yang berubah, dan tanpa validasi perubahan itu baru ketahuan
 * sebagai `undefined` di tengah perhitungan harga.
 *
 * Batas waktu per panggilan lebih pendek dari anggaran fan-out. Panggilan yang
 * batas waktunya lebih panjang dari anggaran tidak pernah benar-benar
 * dibatalkan oleh batas waktunya sendiri — yang membatalkannya selalu
 * anggaran, dan batas waktu itu menjadi hiasan.
 */

const envelope = <T extends z.ZodType>(data: T) => z.object({ data, error: z.null() })

const directorySchema = envelope(
  z.array(
    z.object({
      // Divalidasi terhadap daftar kode yang dikenal, bukan diterima sebagai
      // string apa pun. Supplier yang tidak dikenal berarti supplier-service
      // dan search-service sedang tidak sepakat, dan meneruskannya akan
      // menyebar ketidaksepakatan itu sampai ke muatan Kafka.
      code: supplierCodeSchema,
      isActive: z.boolean(),
      circuit: z.object({ state: z.enum(['closed', 'half_open', 'open']).optional() }).optional(),
    }),
  ),
)

const pricingSchema = envelope(
  z.object({
    priced: z.array(
      z.object({
        ref: z.string(),
        ok: z.literal(true),
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
 * Penerjemahan jawaban, dipisahkan dari pemanggilannya.
 *
 * Keduanya berisi keputusan yang layak diuji — apa yang terjadi pada keadaan
 * pemutus yang tidak disebutkan, dan apa yang terjadi pada item yang gagal
 * dihitung harganya — sementara pemanggilannya hanya `undici` dan tidak
 * memutuskan apa pun. Memisahkannya membuat keputusan itu dapat diuji tanpa
 * satu pun soket terbuka.
 */
export function toDirectory(body: unknown): readonly SupplierStatus[] {
  return directorySchema.parse(body).data.map((row) => ({
    supplier: row.code,
    isActive: row.isActive,
    // Keadaan pemutus yang tidak disebutkan dianggap TERTUTUP. Menganggapnya
    // terbuka akan membuat seluruh supplier dilewati begitu bentuk jawabannya
    // berubah — pencarian yang kosong tanpa satu pun galat, dan tidak ada
    // yang memicu peringatan apa pun.
    circuit: row.circuit?.state ?? 'closed',
  }))
}

/**
 * Item yang gagal dihitung TIDAK diambil.
 *
 * pricing-service memisahkan yang berhasil dari yang gagal dengan sengaja.
 * Mengambil keduanya berarti mengembalikan harga yang tidak pernah dihitung —
 * dan satu-satunya harga yang tersedia untuk item seperti itu adalah harga
 * supplier, yang berarti menjual tanpa markup.
 */
export function toPricedItems(body: unknown): readonly PricedItem[] {
  return pricingSchema.parse(body).data.priced.map((item) => ({
    ref: item.ref,
    base: item.breakdown.base,
    markup: item.breakdown.markup,
    tax: item.breakdown.tax,
    total: item.breakdown.total,
    taxName: item.breakdown.taxName,
  }))
}

export interface GatewayOptions {
  readonly baseUrl: string
  readonly timeoutMs: number
}

export function createHttpSupplierGateway(options: GatewayOptions): SupplierGateway {
  return {
    async search(
      supplier: string,
      criteria: SupplierSearchCriteria,
    ): Promise<SupplierSearchResult> {
      const body = await post(options, '/internal/suppliers/search', { supplier, ...criteria })

      return searchResultSchema.parse(unwrap(body))
    },

    async directory(): Promise<readonly SupplierStatus[]> {
      return toDirectory(await get(options, '/internal/suppliers'))
    },
  }
}

export function createHttpPricingGateway(options: GatewayOptions): PricingGateway {
  return {
    async price(items: readonly PricingRequestItem[]): Promise<readonly PricedItem[]> {
      return toPricedItems(await post(options, '/internal/pricing/rate-plans', { items }))
    },
  }
}

async function post(options: GatewayOptions, path: string, body: unknown): Promise<unknown> {
  const response = await request(`${options.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    headersTimeout: options.timeoutMs,
    bodyTimeout: options.timeoutMs,
  })

  const payload: unknown = await response.body.json()

  if (response.statusCode >= 400) {
    throw new Error(`${path} menjawab ${String(response.statusCode)}`)
  }

  return payload
}

async function get(options: GatewayOptions, path: string): Promise<unknown> {
  const response = await request(`${options.baseUrl}${path}`, {
    method: 'GET',
    headersTimeout: options.timeoutMs,
    bodyTimeout: options.timeoutMs,
  })

  const payload: unknown = await response.body.json()

  if (response.statusCode >= 400) {
    throw new Error(`${path} menjawab ${String(response.statusCode)}`)
  }

  return payload
}

function unwrap(body: unknown): unknown {
  return (body as { data?: unknown }).data
}
