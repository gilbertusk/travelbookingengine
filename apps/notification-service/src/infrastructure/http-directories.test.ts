import { UpstreamError } from '@tbe/shared-kernel'
import { describe, expect, test } from 'vitest'
import {
  createHttpBookingDirectory,
  createHttpVoucherDocuments,
  toDocument,
  toSnapshotLookup,
  type HttpResponse,
} from './http-directories.js'

const BOOKING_ID = '018f2a1c-0000-7000-8000-00000000b001'

function json(status: number, body: unknown): HttpResponse {
  return {
    status,
    contentType: 'application/json; charset=utf-8',
    body: new TextEncoder().encode(JSON.stringify(body)),
  }
}

const SOURCE = {
  id: BOOKING_ID,
  userId: '7b9e2d14-1f3a-4e5c-8d6b-2a1c0f9e8d7c',
  status: 'CONFIRMED',
  supplierRef: 'SKY-BK-7F3A21',
  checkIn: '2026-11-10',
  checkOut: '2026-11-12',
  guestCount: 2,
  leadGuest: { fullName: 'Sari Wulandari', email: 'sari@example.com' },
  roomTypeName: 'Deluxe King',
  total: { amountMinor: 2_442_000, currency: 'IDR' },
}

const NOT_FOUND = { data: null, error: { code: 'NOT_FOUND', message: 'tidak ada' } }

describe('jawaban booking-service', () => {
  test('pemesanan dipetakan ke snapshot', () => {
    expect(toSnapshotLookup(json(200, { data: SOURCE, error: null }))).toEqual({
      kind: 'found',
      booking: {
        bookingId: BOOKING_ID,
        userId: SOURCE.userId,
        status: 'CONFIRMED',
        supplierRef: 'SKY-BK-7F3A21',
        checkIn: '2026-11-10',
        checkOut: '2026-11-12',
        guestCount: 2,
        leadGuest: SOURCE.leadGuest,
        roomTypeName: 'Deluxe King',
        total: SOURCE.total,
      },
    })
  })

  test('404 beramplop NOT_FOUND berarti pemesanan tidak ada', () => {
    expect(toSnapshotLookup(json(404, NOT_FOUND))).toEqual({ kind: 'not_found' })
  })

  test.each([
    ['404 telanjang', json(404, { message: 'Cannot GET' })],
    ['5xx', json(503, { error: { code: 'X' } })],
    ['tanpa jawaban', { status: 0, contentType: '', body: new Uint8Array() }],
    ['bentuk berubah', json(200, { data: { ...SOURCE, leadGuest: undefined }, error: null })],
    [
      'bukan JSON',
      { status: 200, contentType: 'text/html', body: new TextEncoder().encode('<p>') },
    ],
    [
      'JSON rusak',
      { status: 200, contentType: 'application/json', body: new TextEncoder().encode('{') },
    ],
  ])('%s dilempar sebagai galat sementara', (_name, response) => {
    expect(() => toSnapshotLookup(response)).toThrow(UpstreamError)
  })
})

describe('jawaban voucher-service', () => {
  test('PDF dikembalikan apa adanya', () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46])

    expect(toDocument({ status: 200, contentType: 'application/pdf', body: pdf })).toEqual(pdf)
  })

  test('voucher yang belum terbit dijawab undefined', () => {
    expect(toDocument(json(404, NOT_FOUND))).toBeUndefined()
  })

  test('200 yang bukan PDF dilempar: lebih baik menunggu daripada melampirkan sampah', () => {
    expect(() => toDocument(json(200, { data: {} }))).toThrow(UpstreamError)
  })

  test('404 telanjang dan 5xx dilempar', () => {
    expect(() => toDocument(json(404, {}))).toThrow(UpstreamError)
    expect(() => toDocument(json(500, {}))).toThrow(UpstreamError)
  })
})

describe('alamat yang dipanggil', () => {
  test('rute /internal kedua service', async () => {
    const urls: string[] = []
    const transport = async (url: string): Promise<HttpResponse> => {
      urls.push(url)
      return await Promise.resolve(
        url.includes('booking')
          ? json(200, { data: SOURCE, error: null })
          : { status: 200, contentType: 'application/pdf', body: new Uint8Array([1]) },
      )
    }

    await createHttpBookingDirectory('http://booking:4006', transport).notificationSource(
      BOOKING_ID,
    )
    await createHttpVoucherDocuments('http://voucher:4008', transport).document(BOOKING_ID)

    expect(urls).toEqual([
      `http://booking:4006/internal/bookings/${BOOKING_ID}/notification-source`,
      `http://voucher:4008/internal/vouchers/${BOOKING_ID}/document`,
    ])
  })
})
