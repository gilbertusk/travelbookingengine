import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { ServiceUrls } from './undici-upstream.js'
import { classifyFailure, createUndiciUpstream } from './undici-upstream.js'

/**
 * Klien hulu diuji terhadap server HTTP sungguhan, bukan undici yang ditiru.
 *
 * Yang perlu dibuktikan di sini bukan bahwa undici memanggil undici, melainkan
 * bahwa kegagalan jaringan dipetakan ke jenis yang benar. Batas waktu dan
 * "tidak dapat dihubungi" hanya muncul dari soket nyata.
 */

const SLOW_RESPONSE_MS = 3_000
const LAMBAT = '/lambat'

let server: Server
let baseUrl: string
/** Port yang pernah dibuka lalu ditutup: dijamin tidak ada yang mendengarkan. */
let portMati: number

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === LAMBAT) {
      setTimeout(() => {
        res.writeHead(200).end('terlambat')
      }, SLOW_RESPONSE_MS).unref()
      return
    }

    if (req.url === '/health/live') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}')
      return
    }

    if (req.url === '/rusak/health/live') {
      res.writeHead(503).end('tidak sehat')
      return
    }

    const potongan: Buffer[] = []
    req.on('data', (bagian: Buffer) => potongan.push(bagian))
    req.on('end', () => {
      res.writeHead(201, { 'content-type': 'application/json', 'x-echo-method': req.method ?? '' })
      res.end(
        JSON.stringify({
          path: req.url,
          headerDiterima: req.headers['x-tbe-user-id'] ?? null,
          badan: Buffer.concat(potongan).toString('utf8'),
        }),
      )
    })
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`

  const sementara = createServer()
  await new Promise<void>((resolve) => {
    sementara.listen(0, '127.0.0.1', resolve)
  })
  portMati = (sementara.address() as AddressInfo).port
  await new Promise<void>((resolve) => {
    sementara.close(() => {
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

function urls(overrides: Partial<ServiceUrls> = {}): ServiceUrls {
  return {
    auth: baseUrl,
    search: baseUrl,
    booking: baseUrl,
    payment: baseUrl,
    voucher: baseUrl,
    pricing: baseUrl,
    analytics: baseUrl,
    ...overrides,
  }
}

async function baca(stream: Readable): Promise<string> {
  const potongan: Buffer[] = []
  for await (const bagian of stream) potongan.push(Buffer.from(bagian as Buffer))
  return Buffer.concat(potongan).toString('utf8')
}

describe('pengiriman ke hulu', () => {
  test('meneruskan metode, path, header, dan badan lalu mengembalikan respons', async () => {
    const upstream = createUndiciUpstream(urls())

    const hasil = await upstream.send({
      service: 'booking',
      method: 'POST',
      path: '/bookings',
      headers: { 'x-tbe-user-id': 'usr_1', 'content-type': 'application/json' },
      body: Readable.from(['{"kamar":2}']),
      timeoutMs: 5_000,
    })

    expect(hasil.kind).toBe('response')
    if (hasil.kind !== 'response') return

    expect(hasil.statusCode).toBe(201)
    expect(hasil.headers['x-echo-method']).toBe('POST')
    expect(JSON.parse(await baca(hasil.body))).toEqual({
      path: '/bookings',
      headerDiterima: 'usr_1',
      badan: '{"kamar":2}',
    })
  })

  test('meneruskan permintaan tanpa badan tanpa menggantung', async () => {
    const upstream = createUndiciUpstream(urls())

    const hasil = await upstream.send({
      service: 'search',
      method: 'GET',
      path: '/search?city=Bali',
      headers: {},
      body: undefined,
      timeoutMs: 5_000,
    })

    expect(hasil.kind).toBe('response')
    if (hasil.kind !== 'response') return
    expect(JSON.parse(await baca(hasil.body))).toMatchObject({ path: '/search?city=Bali' })
  })

  test('mengembalikan status galat hulu apa adanya, bukan menjadikannya kegagalan', async () => {
    // 503 dari hulu adalah jawaban, bukan kegagalan transport. Menyamakan
    // keduanya membuat gateway menulis ulang respons yang sudah benar.
    const upstream = createUndiciUpstream(urls())

    const hasil = await upstream.send({
      service: 'auth',
      method: 'GET',
      path: '/rusak/health/live',
      headers: {},
      body: undefined,
      timeoutMs: 5_000,
    })

    expect(hasil.kind).toBe('response')
    if (hasil.kind !== 'response') return
    expect(hasil.statusCode).toBe(503)
  })

  test('menandai batas waktu terlampaui secara terpisah dari kegagalan lain', async () => {
    const upstream = createUndiciUpstream(urls())

    const hasil = await upstream.send({
      service: 'search',
      method: 'GET',
      path: LAMBAT,
      headers: {},
      body: undefined,
      timeoutMs: 150,
    })

    expect(hasil.kind).toBe('timeout')
  })

  test('menandai service yang tidak dapat dihubungi', async () => {
    // Perbedaan ini menentukan: pada batas waktu, hulu mungkin sudah
    // mengerjakan permintaannya — pada koneksi yang ditolak, pasti belum.
    const upstream = createUndiciUpstream(urls({ payment: `http://127.0.0.1:${String(portMati)}` }))

    const hasil = await upstream.send({
      service: 'payment',
      method: 'POST',
      path: '/payments',
      headers: {},
      body: undefined,
      timeoutMs: 5_000,
    })

    expect(hasil.kind).toBe('unreachable')
  })
})

describe('probe kesehatan hulu', () => {
  test('mengembalikan true saat service membalas sehat', async () => {
    await expect(createUndiciUpstream(urls()).probe('auth')).resolves.toBe(true)
  })

  test('mengembalikan false saat service membalas 5xx', async () => {
    const upstream = createUndiciUpstream(urls({ auth: `${baseUrl}/rusak` }))

    await expect(upstream.probe('auth')).resolves.toBe(false)
  })

  test('mengembalikan false saat service tidak dapat dihubungi', async () => {
    const upstream = createUndiciUpstream(urls({ voucher: `http://127.0.0.1:${String(portMati)}` }))

    await expect(upstream.probe('voucher')).resolves.toBe(false)
  })
})

describe('klasifikasi kegagalan', () => {
  test('setiap jenis batas waktu undici dipetakan menjadi timeout', () => {
    for (const code of [
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_BODY_TIMEOUT',
      'UND_ERR_CONNECT_TIMEOUT',
    ]) {
      expect(classifyFailure({ code })).toBe('timeout')
    }
  })

  test('kegagalan lain dipetakan menjadi unreachable', () => {
    expect(classifyFailure({ code: 'ECONNREFUSED' })).toBe('unreachable')
    expect(classifyFailure({ code: 'ENOTFOUND' })).toBe('unreachable')
  })

  test('nilai yang dilempar tanpa kode tetap terklasifikasi, bukan melempar lagi', () => {
    // Kegagalan saat menangani kegagalan adalah cara gateway berhenti
    // merespons sama sekali.
    expect(classifyFailure(undefined)).toBe('unreachable')
    expect(classifyFailure(null)).toBe('unreachable')
    expect(classifyFailure('galat berupa string')).toBe('unreachable')
    expect(classifyFailure(new Error('tanpa kode'))).toBe('unreachable')
    expect(classifyFailure({ code: 42 })).toBe('unreachable')
  })
})
