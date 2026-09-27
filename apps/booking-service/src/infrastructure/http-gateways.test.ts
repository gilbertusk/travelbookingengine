import { createServer } from 'node:http'
import { money } from '@tbe/money'
import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import {
  createHttpPricing,
  createHttpSupplierQuotes,
  toSellQuote,
  toSupplierAnswer,
  undiciTransport,
  type HttpResponse,
  type Transport,
} from './http-gateways.js'
import { notifiesExpiry } from './keyspace-expiry.js'
import { bookingIdOfExpiredKey, LOCK_PREFIX } from './redis-hold-store.js'

const STAY = {
  supplier: 'SKY' as const,
  supplierRatePlanId: 'SKY-RP-DLX-BB',
  checkIn: '2026-11-10',
  checkOut: '2026-11-12',
}

function recording(response: HttpResponse): { transport: Transport; calls: [string, unknown][] } {
  const calls: [string, unknown][] = []
  return {
    calls,
    transport: async (url, body) => {
      calls.push([url, body])
      return await Promise.resolve(response)
    },
  }
}

const error = (status: number, code: string): HttpResponse => ({
  status,
  body: { data: null, error: { code, message: 'x' } },
})

describe('jawaban supplier-service menjadi keputusan', () => {
  test('price check berhasil diurai menjadi uang', async () => {
    const { transport, calls } = recording({
      status: 200,
      body: {
        data: {
          supplierRatePlanId: 'SKY-RP-DLX-BB',
          total: { amountMinor: 2_000_000, currency: 'IDR' },
          changed: false,
        },
        error: null,
      },
    })

    const answer = await createHttpSupplierQuotes('http://supplier', transport).priceCheck(STAY)

    expect(answer).toEqual({ kind: 'ok', value: { total: money(2_000_000, 'IDR') } })
    expect(calls).toEqual([['http://supplier/internal/suppliers/price-check', STAY]])
  })

  test('hold berhasil membawa token, kedaluwarsa sebagai titik waktu, dan total', async () => {
    const { transport, calls } = recording({
      status: 200,
      body: {
        data: {
          supplierHoldId: 'sky-hold-9',
          expiresAt: '2026-10-01T03:20:00.000Z',
          total: { amountMinor: 2_000_000, currency: 'IDR' },
        },
        error: null,
      },
    })

    const answer = await createHttpSupplierQuotes('http://supplier', transport).hold({
      ...STAY,
      guests: 2,
    })

    expect(answer).toEqual({
      kind: 'ok',
      value: {
        holdRef: 'sky-hold-9',
        expiresAt: new Date('2026-10-01T03:20:00.000Z'),
        total: money(2_000_000, 'IDR'),
      },
    })
    expect(calls[0]?.[1]).toEqual({ ...STAY, guests: 2 })
  })

  test.each([
    [error(409, 'SOLD_OUT'), { kind: 'rejected', reason: 'sold_out' }],
    [error(404, 'NOT_FOUND'), { kind: 'rejected', reason: 'not_found' }],
    // 409 lain bukan penolakan: price check berikutnya yang akan melihat
    // perubahannya sendiri. Membatalkan pemesanan di sini salah.
    [error(409, 'PRICE_CHANGED'), { kind: 'unreachable' }],
    [error(503, 'SUPPLIER_UNAVAILABLE'), { kind: 'unreachable' }],
    [error(504, 'SUPPLIER_TIMEOUT'), { kind: 'unreachable' }],
    [error(0, 'NETWORK'), { kind: 'unreachable' }],
    [{ status: 409, body: 'bukan json' }, { kind: 'unreachable' }],
  ] as const)('status %o menjadi %o', (response, expected) => {
    expect(toSupplierAnswer(response, z.object({}))).toEqual(expected)
  })

  test('jawaban 200 yang bentuknya berubah tidak dipercaya', async () => {
    const { transport } = recording({ status: 200, body: { data: { total: 5 }, error: null } })

    expect(await createHttpSupplierQuotes('http://supplier', transport).priceCheck(STAY)).toEqual({
      kind: 'unreachable',
    })
  })

  test.each([
    ['price check', 'priceCheck'],
    ['hold', 'hold'],
  ] as const)('%s dengan mata uang yang tidak dikenal tidak dipercaya', async (_name, method) => {
    const body = {
      data: {
        supplierRatePlanId: 'x',
        supplierHoldId: 'h',
        expiresAt: '2026-10-01T03:20:00.000Z',
        changed: false,
        total: { amountMinor: 1, currency: 'XYZ' },
      },
      error: null,
    }
    const quotes = createHttpSupplierQuotes(
      'http://supplier',
      recording({ status: 200, body }).transport,
    )

    const answer =
      method === 'hold' ? await quotes.hold({ ...STAY, guests: 1 }) : await quotes.priceCheck(STAY)

    expect(answer).toEqual({ kind: 'unreachable' })
  })
})

describe('jawaban pricing-service', () => {
  const priced = (ref: string) => ({
    status: 200,
    body: {
      data: {
        priced: [
          {
            ref,
            ok: true,
            breakdown: {
              base: { amountMinor: 2_000_000, currency: 'IDR' },
              markup: { amountMinor: 200_000, currency: 'IDR' },
              tax: { amountMinor: 242_000, currency: 'IDR' },
              total: { amountMinor: 2_442_000, currency: 'IDR' },
              taxName: 'PPN 11%',
            },
          },
        ],
        failed: [],
      },
      error: null,
    },
  })

  test('harga jual untuk rate plan yang diminta', async () => {
    const { transport, calls } = recording(priced('bkg-1'))
    const request = {
      ref: 'bkg-1',
      supplier: 'SKY' as const,
      city: 'Denpasar',
      supplierTotal: money(2_000_000, 'IDR'),
    }

    const quote = await createHttpPricing('http://pricing', transport).sellPrice(request)

    expect(quote?.total).toEqual(money(2_442_000, 'IDR'))
    expect(quote?.taxName).toBe('PPN 11%')
    expect(calls).toEqual([['http://pricing/internal/pricing/rate-plans', { items: [request] }]])
  })

  test('item yang gagal dihitung tidak diganti harga supplier', () => {
    expect(toSellQuote(priced('lain'), 'bkg-1')).toBeUndefined()
  })

  test.each([
    ['status gagal', { status: 503, body: {} }],
    ['bentuk berubah', { status: 200, body: { data: { priced: 'x' }, error: null } }],
  ])('%s: tidak ada harga', (_name, response) => {
    expect(toSellQuote(response, 'bkg-1')).toBeUndefined()
  })

  test('uang yang tidak dikenal di salah satu komponen: tidak ada harga', () => {
    const response = priced('bkg-1')
    const body = structuredClone(response.body)
    const item = body.data.priced[0]
    if (item !== undefined) item.breakdown.tax.currency = 'XYZ'

    expect(toSellQuote({ status: 200, body }, 'bkg-1')).toBeUndefined()
  })
})

describe('transport undici', () => {
  test('meneruskan badan JSON dan header korelasi, dan mengembalikan status apa adanya', async () => {
    const received: { body: string; correlation: string | undefined }[] = []
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk: Buffer) => {
        raw += chunk.toString()
      })
      req.on('end', () => {
        received.push({ body: raw, correlation: req.headers['x-correlation-id']?.toString() })
        res.writeHead(409, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: null, error: { code: 'SOLD_OUT' } }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0

    try {
      const transport = undiciTransport(2_000, () => ({ 'x-correlation-id': 'corr-1' }))
      const response = await transport(`http://127.0.0.1:${String(port)}/x`, { a: 1 })

      expect(response).toEqual({ status: 409, body: { data: null, error: { code: 'SOLD_OUT' } } })
      expect(received).toEqual([{ body: '{"a":1}', correlation: 'corr-1' }])
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  test('kegagalan jaringan menjadi status 0, bukan pengecualian', async () => {
    const transport = undiciTransport(200, () => ({}))

    const response = await transport('http://127.0.0.1:1/tidak-ada', {})

    expect(response.status).toBe(0)
  })
})

describe('keyspace notification', () => {
  test.each([
    ['Ex', true],
    ['KEx', true],
    ['EA', true],
    ['Kx', false],
    ['E', false],
    ['', false],
  ])('flag %j berarti notifikasi kedaluwarsa %s', (flags, expected) => {
    expect(notifiesExpiry(flags)).toBe(expected)
  })

  test('kunci waktu hold menjadi pengenal pemesanan; kunci lain diabaikan', () => {
    expect(bookingIdOfExpiredKey(`${LOCK_PREFIX}abc`)).toBe('abc')
    expect(bookingIdOfExpiredKey('search:cache:denpasar')).toBeUndefined()
  })
})
