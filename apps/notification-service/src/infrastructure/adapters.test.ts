import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Registry } from 'prom-client'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { undiciTransport } from './http-directories.js'
import { createDeliveryMetrics } from './prom-metrics.js'
import { createSmtpSender, createSmtpTransport } from './smtp-sender.js'
import { systemClock, uuidSource } from './system.js'

/** Adapter tipis yang tidak butuh infrastruktur — cukup soket lokal. */

let server: Server
let baseUrl = ''
const seenHeaders: Record<string, string | string[] | undefined>[] = []

beforeAll(async () => {
  server = createServer((req, res) => {
    seenHeaders.push(req.headers)
    if (req.url === '/pdf') {
      res.writeHead(200, { 'content-type': 'application/pdf' })
      res.end(Buffer.from('%PDF-'))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND' } }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}` // address() bertipe string|AddressInfo; soket TCP selalu AddressInfo
})

afterAll(async () => {
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve()
    }),
  )
})

describe('transport undici', () => {
  test('membawa status, jenis isi, dan byte jawaban, beserta correlationId', async () => {
    const transport = undiciTransport(
      1_000,
      () => ({ 'x-correlation-id': 'corr-7' }),
      () => undefined,
    )

    const response = await transport(`${baseUrl}/pdf`)

    expect(response.status).toBe(200)
    expect(response.contentType).toBe('application/pdf')
    expect(new TextDecoder().decode(response.body)).toBe('%PDF-')
    expect(seenHeaders.at(-1)?.['x-correlation-id']).toBe('corr-7')
  })

  test('service yang tidak dapat dihubungi menjadi status 0 dan penyebabnya dilaporkan', async () => {
    const failures: string[] = []
    const transport = undiciTransport(
      500,
      () => ({}),
      (url) => failures.push(url),
    )

    const response = await transport('http://127.0.0.1:1/apa-saja')

    expect(response.status).toBe(0)
    expect(failures).toEqual(['http://127.0.0.1:1/apa-saja'])
  })
})

describe('metrik penghantaran', () => {
  test('dihitung per jenis surel dan hasil', async () => {
    const registry = new Registry()
    const metrics = createDeliveryMetrics(registry)

    metrics.delivered('booking_failed', 'dead')
    metrics.delivered('booking_failed', 'dead')

    const text = await registry.metrics()
    expect(text).toContain('notification_deliveries_total{type="booking_failed",outcome="dead"} 2')
  })
})

describe('sistem', () => {
  test('pengenal adalah UUID v7 yang berbeda setiap kali', () => {
    const first = uuidSource.next()

    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/)
    expect(uuidSource.next()).not.toBe(first)
  })

  test('jam adalah waktu sekarang', () => {
    expect(Math.abs(systemClock.now().getTime() - Date.now())).toBeLessThan(1_000)
  })
})

describe('transport SMTP', () => {
  test('server yang tidak dapat dihubungi adalah kegagalan sementara', async () => {
    const smtp = createSmtpTransport({
      host: '127.0.0.1',
      port: 1,
      secure: false,
      user: 'tbe',
      password: 'bukan-rahasia',
      timeoutMs: 500,
    })
    await smtp.resource.start?.()

    const result = await createSmtpSender(smtp.transport, 'x@lintang.test').send({
      to: 'sari@example.com',
      subject: 's',
      text: 't',
      html: '<p>t</p>',
      attachments: [],
    })

    expect(result.kind).toBe('transient')
    await smtp.resource.stop()
  })
})
