import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ApiError } from '@/lib/api-error'
import { sampleBooking, sampleStatus } from '@/testing/booking'
import { acceptPrice, fetchBooking, fetchStatus, placeHold, priceCheck, startPayment } from './api'
import { readBookingLabel, rememberBookingLabel, sessionStore } from './session-store'

const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function reply(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data, error: null }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function respondWith(data: unknown): void {
  // Satu Response baru per panggilan: badannya hanya dapat dibaca sekali.
  fetchMock.mockImplementation(async () => await Promise.resolve(reply(data)))
}

function sent(call = 0): { url: string; method: string; body: unknown } {
  const [url, init] = fetchMock.mock.calls[call] ?? []
  const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined
  return { url: urlOf(url), method: init?.method ?? 'GET', body }
}

describe('panggilan alur pemesanan lewat api-gateway', () => {
  test('price check: data tamu dan jumlah tamu dikirim bersama harga yang dilihat', async () => {
    respondWith(sampleBooking())

    const booking = await priceCheck({
      idempotencyKey: 'web-1',
      supplier: 'SKY',
      propertyId: 'sky-1',
      city: 'Bali',
      ratePlanRef: 'SKY-RP-1',
      checkIn: '2026-11-10',
      checkOut: '2026-11-12',
      guests: 3,
      guest: { fullName: 'Budi', email: 'budi@example.test' },
      displayedTotal: { amountMinor: 2_442_000, currency: 'IDR' },
    })

    expect(booking.status).toBe('PRICE_CHECKED')
    expect(sent()).toMatchObject({
      url: expect.stringMatching(/\/bookings\/price-check$/),
      method: 'POST',
      body: {
        idempotencyKey: 'web-1',
        guest: { fullName: 'Budi', email: 'budi@example.test', count: 3 },
        displayedTotal: { amountMinor: 2_442_000, currency: 'IDR' },
      },
    })
  })

  test.each([
    [
      'persetujuan harga',
      async () => await acceptPrice('b-1'),
      /\/bookings\/price-check\/accept$/,
      'POST',
    ],
    ['hold', async () => await placeHold('b-1', 4), /\/bookings\/hold$/, 'POST'],
    ['pemesanan', async () => await fetchBooking('b-1'), /\/bookings\/b-1$/, 'GET'],
  ])('%s', async (_name, call, path, method) => {
    respondWith(sampleBooking())

    await call()

    expect(sent().url).toMatch(path)
    expect(sent().method).toBe(method)
  })

  test('status', async () => {
    respondWith(sampleStatus())

    expect((await fetchStatus('b-1')).status).toBe('PAID')
    expect(sent().url).toMatch(/\/bookings\/b-1\/status$/)
  })

  test('membuka pembayaran', async () => {
    fetchMock.mockResolvedValue(
      reply({ paymentId: 'p', redirectUrl: 'https://r', snapToken: 't', booking: sampleBooking() }),
    )

    expect((await startPayment('b-1')).snapToken).toBe('t')
    expect(sent()).toMatchObject({
      url: expect.stringMatching(/\/bookings\/b-1\/payment$/),
      method: 'POST',
    })
  })

  test('jawaban yang bentuknya tidak dikenal menjadi galat server, bukan undefined di layar', async () => {
    respondWith({ id: 'b-1', status: 'HELD' })

    await expect(fetchBooking('b-1')).rejects.toMatchObject({
      kind: 'server',
      code: 'MALFORMED_RESPONSE',
    })
    await expect(fetchBooking('b-1')).rejects.toBeInstanceOf(ApiError)
  })
})

describe('nama pemesanan untuk halaman status', () => {
  test('disimpan dan dibaca kembali', () => {
    rememberBookingLabel('b-1', { propertyName: 'Padma', roomName: 'Deluxe' })

    expect(readBookingLabel('b-1')).toEqual({ propertyName: 'Padma', roomName: 'Deluxe' })
  })

  test('tidak ada, atau rusak: dianggap tidak ada', () => {
    expect(readBookingLabel('b-2')).toBeUndefined()

    sessionStore.set('tbe:booking-label:b-3', '{rusak')
    expect(readBookingLabel('b-3')).toBeUndefined()

    sessionStore.set('tbe:booking-label:b-4', JSON.stringify({ propertyName: 7 }))
    expect(readBookingLabel('b-4')).toBeUndefined()
  })

  test('penyimpanan yang ditolak peramban tidak menghentikan apa pun', () => {
    const failing = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    const reading = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })

    expect(() => {
      rememberBookingLabel('b-5', { propertyName: 'Padma' })
    }).not.toThrow()
    expect(readBookingLabel('b-5')).toBeUndefined()
    expect(() => {
      sessionStore.remove('x')
    }).not.toThrow()

    failing.mockRestore()
    reading.mockRestore()
  })
})

function urlOf(input: RequestInfo | URL | undefined): string {
  if (input === undefined || typeof input === 'string') return input ?? ''
  return input instanceof URL ? input.href : input.url
}
