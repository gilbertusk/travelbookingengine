import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createSkyAdapter } from '../adapters/sky.js'
import { classifyTransportFailure, createSupplierHttp, DEFAULT_TIMEOUTS } from './client.js'

/**
 * Klien HTTP terhadap server sungguhan.
 *
 * Batas waktu dan koneksi yang ditolak hanya muncul dari soket nyata. Meniru
 * undici di sini hanya akan membuktikan bahwa tiruannya berperilaku seperti
 * yang dibayangkan penulisnya — dan pemetaan kode galat undici adalah persis
 * bagian yang tidak boleh dibayangkan.
 */

const SLOW_MS = 3_000

let server: Server
let baseUrl: string
/** Port yang pernah dibuka lalu ditutup: dijamin tidak ada yang mendengarkan. */
let deadPort: number

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/lambat') {
      setTimeout(() => {
        res.writeHead(200).end('{}')
      }, SLOW_MS).unref()
      return
    }

    if (req.url === '/penuh') {
      res.writeHead(429, { 'retry-after': '30' }).end(JSON.stringify({ error: 'RATE_LIMITED' }))
      return
    }

    if (req.url === '/putus') {
      // Permintaan diterima, lalu koneksinya diputus tanpa jawaban.
      req.socket.destroy()
      return
    }

    if (req.url === '/istirahat') {
      res.writeHead(503, { 'retry-after': '12' }).end(JSON.stringify({ error: 'UNAVAILABLE' }))
      return
    }

    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ echo: { method: req.method, url: req.url, headers: req.headers } }))
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`

  const temporary = createServer()
  await new Promise<void>((resolve) => {
    temporary.listen(0, '127.0.0.1', resolve)
  })
  deadPort = (temporary.address() as AddressInfo).port
  await new Promise<void>((resolve) => {
    temporary.close(() => {
      resolve()
    })
  })
})

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve()
    })
  })
})

describe('pengiriman', () => {
  test('meneruskan metode, path, dan header', async () => {
    const http = createSupplierHttp('SKY', { baseUrl })

    const result = await http.send({
      operation: 'search',
      method: 'POST',
      path: '/apa-saja',
      contentType: 'application/json',
      body: '{"a":1}',
      idempotencyKey: 'kunci-1',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const body = JSON.parse(result.value.text) as {
      echo: { method: string; url: string; headers: Record<string, string> }
    }
    expect(body.echo.method).toBe('POST')
    expect(body.echo.url).toBe('/apa-saja')
    expect(body.echo.headers['idempotency-key']).toBe('kunci-1')
  })

  test('status non-2xx dikembalikan sebagai Ok, bukan kegagalan transport', async () => {
    // Arti 409 berbeda pada setiap supplier, dan hanya adapter yang tahu di
    // mana kodenya berada. Klien tidak boleh memutuskannya.
    const http = createSupplierHttp('SKY', { baseUrl })

    const result = await http.send({ operation: 'search', method: 'GET', path: '/penuh' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.status).toBe(429)
    expect(result.value.headers['retry-after']).toBe('30')
  })
})

describe('kegagalan transport', () => {
  test('batas waktu terlampaui menghasilkan timeout', async () => {
    const http = createSupplierHttp('SKY', { baseUrl, timeouts: { search: 150 } })

    const result = await http.send({ operation: 'search', method: 'GET', path: '/lambat' })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('timeout')
    expect(result.error.supplier).toBe('SKY')
    expect(result.error.operation).toBe('search')
  })

  test('batas waktu melaporkan berapa lama ia menunggu', async () => {
    const http = createSupplierHttp('LUNA', { baseUrl, timeouts: { search: 120 } })

    const result = await http.send({ operation: 'search', method: 'GET', path: '/lambat' })

    expect(result.ok).toBe(false)
    if (result.ok || result.error.kind !== 'timeout') return
    expect(result.error.timeoutMs).toBe(120)
  })

  test('supplier yang tidak dapat dihubungi menghasilkan unavailable', async () => {
    // Dibedakan dari timeout dengan sengaja: pada koneksi yang ditolak,
    // supplier PASTI belum mengerjakan permintaannya.
    const http = createSupplierHttp('ZEPH', { baseUrl: `http://127.0.0.1:${String(deadPort)}` })

    const result = await http.send({ operation: 'book', method: 'POST', path: '/bookings' })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('unavailable')
  })

  test('batas waktu berbeda per operasi', () => {
    // Pengguna menunggu di depan layar saat mencari; konfirmasi pemesanan
    // boleh memakan waktu jauh lebih lama asal benar.
    expect(DEFAULT_TIMEOUTS.search).toBeLessThan(DEFAULT_TIMEOUTS.book)
    expect(DEFAULT_TIMEOUTS.search).toBeLessThan(DEFAULT_TIMEOUTS.hold)
  })

  test('seluruh kode batas waktu undici dikenali', () => {
    for (const code of [
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_BODY_TIMEOUT',
      'UND_ERR_CONNECT_TIMEOUT',
    ]) {
      expect(classifyTransportFailure('SKY', 'search', 100, { code }).kind).toBe('timeout')
    }
  })

  test('koneksi yang tidak pernah terbentuk dianggap tidak dapat dihubungi', () => {
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']) {
      expect(classifyTransportFailure('SKY', 'book', 100, { code }).kind).toBe('unavailable')
    }
  })

  test('kode di dalam cause dikenali, seperti galat soket yang dibungkus undici', () => {
    const wrapped = new Error('fetch failed', { cause: { code: 'ECONNREFUSED' } })

    expect(classifyTransportFailure('SKY', 'book', 100, wrapped).kind).toBe('unavailable')
  })

  test('koneksi yang putus SETELAH terbentuk tidak pasti, bukan tidak dapat dihubungi', () => {
    // Supplier mungkin sudah menyimpan pemesanan sebelum memutus koneksinya.
    // Menggolongkannya "pasti belum sampai" membuat book dikirim ulang tanpa
    // bertanya dan saga mengembalikan dana untuk kamar yang terpesan (Step 20).
    for (const cause of [
      { code: 'ECONNRESET' },
      { code: 'UND_ERR_SOCKET' },
      { code: 'EPIPE' },
      new Error('tanpa kode'),
      undefined,
      'galat berupa string',
    ]) {
      const error = classifyTransportFailure('SKY', 'book', 100, cause)
      expect(error.kind).toBe('upstream_error')
      if (error.kind !== 'upstream_error') return
      expect(error.status).toBe(0)
    }
  })

  test('supplier yang memutus soket di tengah permintaan menghasilkan upstream_error', async () => {
    const http = createSupplierHttp('SKY', { baseUrl })

    const result = await http.send({ operation: 'book', method: 'POST', path: '/putus' })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('upstream_error')
  })
})

describe('adapter di atas transport sungguhan', () => {
  test('batas waktu sampai ke pemanggil sebagai timeout, bukan lemparan', async () => {
    const http = createSupplierHttp('SKY', { baseUrl, timeouts: { search: 150 } })
    const adapter = createSkyAdapter({
      send: async (outbound) => await http.send({ ...outbound, path: '/lambat' }),
    })

    const result = await adapter.search({
      city: 'Bali',
      checkIn: '2026-11-10',
      checkOut: '2026-11-12',
      guests: 2,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('timeout')
  })

  test('503 menjadi unavailable dengan jeda yang diminta supplier', async () => {
    const http = createSupplierHttp('SKY', { baseUrl })
    const adapter = createSkyAdapter({
      send: async (outbound) => await http.send({ ...outbound, path: '/istirahat' }),
    })

    const result = await adapter.search({
      city: 'Bali',
      checkIn: '2026-11-10',
      checkOut: '2026-11-12',
      guests: 2,
    })

    expect(result.ok).toBe(false)
    if (result.ok || result.error.kind !== 'unavailable') return
    expect(result.error.retryAfterSeconds).toBe(12)
  })

  test('429 menjadi rate_limited dengan jeda yang diminta supplier', async () => {
    const http = createSupplierHttp('ZEPH', { baseUrl })
    const adapter = createSkyAdapter({
      send: async (outbound) => await http.send({ ...outbound, path: '/penuh' }),
    })

    const result = await adapter.search({
      city: 'Bali',
      checkIn: '2026-11-10',
      checkOut: '2026-11-12',
      guests: 2,
    })

    expect(result.ok).toBe(false)
    if (result.ok || result.error.kind !== 'rate_limited') return
    expect(result.error.retryAfterSeconds).toBe(30)
  })
})
