import { UpstreamError } from '@tbe/shared-kernel'
import { describe, expect, test } from 'vitest'
import {
  createHttpBookingDirectory,
  createHttpPropertyDirectory,
  toProperty,
  toSourceLookup,
  type HttpResponse,
  type Transport,
} from './http-directories.js'

const BOOKING_ID = '018f2a1c-0000-7000-8000-00000000b001'
const USER_ID = '7b9e2d14-1f3a-4e5c-8d6b-2a1c0f9e8d7c'

function sourceBody(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      id: BOOKING_ID,
      userId: USER_ID,
      status: 'CONFIRMED',
      supplier: 'SKY',
      supplierRef: 'SKY-BK-1',
      confirmedAt: '2026-10-07T03:00:00.000Z',
      propertyId: 'sky-120804930',
      checkIn: '2026-11-10',
      checkOut: '2026-11-12',
      guests: { count: 2, leadGuestName: 'Sari Wulandari' },
      price: {
        total: { amountMinor: 2_200_000, currency: 'IDR' },
        lineItems: [
          {
            kind: 'room_night',
            description: 'Malam 1',
            amount: { amountMinor: 2_200_000, currency: 'IDR' },
          },
        ],
      },
      terms: {
        roomTypeName: 'Deluxe',
        ratePlanName: 'Room Only',
        breakfastIncluded: false,
        cancellationPolicy: { refundable: true, freeCancellationDays: 3 },
      },
      ...overrides,
    },
    error: null,
  }
}

const ok = (body: unknown): HttpResponse => ({ status: 200, body })
const notFound: HttpResponse = {
  status: 404,
  body: { error: { code: 'NOT_FOUND', message: 'tidak ada' } },
}

describe('jawaban booking-service', () => {
  test('pemesanan diterjemahkan ke bahan voucher', () => {
    const lookup = toSourceLookup(ok(sourceBody()))

    expect(lookup).toMatchObject({
      kind: 'found',
      source: {
        bookingId: BOOKING_ID,
        supplierPropertyId: 'sky-120804930',
        confirmedAt: new Date('2026-10-07T03:00:00.000Z'),
        guestCount: 2,
        leadGuestName: 'Sari Wulandari',
        total: { amountMinor: 2_200_000, currency: 'IDR' },
        terms: { cancellationPolicy: { refundable: true, freeCancellationDays: 3 } },
      },
    })
  })

  test.each([
    [{ refundable: false }, { refundable: false }],
    [{ refundable: true }, { refundable: true }],
  ])('kebijakan %j disalin apa adanya', (policy, expected) => {
    const body = sourceBody({
      terms: { ...sourceBody().data.terms, cancellationPolicy: policy },
    })

    const lookup = toSourceLookup(ok(body))

    expect(lookup.kind === 'found' && lookup.source.terms?.cancellationPolicy).toEqual(expected)
  })

  test('pemesanan sebelum Step 23 tanpa ketentuan dan belum terkonfirmasi', () => {
    const lookup = toSourceLookup(
      ok(sourceBody({ terms: null, confirmedAt: null, status: 'PAID', supplierRef: null })),
    )

    expect(lookup).toMatchObject({ kind: 'found', source: { terms: null, confirmedAt: null } })
  })

  test('404 berarti pemesanan tidak ada — nilai, bukan galat', () => {
    expect(toSourceLookup(notFound)).toEqual({ kind: 'not_found' })
  })

  test.each([
    ['5xx', { status: 503, body: {} }],
    // URL dasar yang salah atau rute yang belum dikerahkan — bukan jawaban.
    ['404 tanpa amplop NOT_FOUND', { status: 404, body: '<html>Not Found</html>' }],
    ['tanpa jawaban', { status: 0, body: {} }],
    ['bentuk yang berubah', ok({ data: { id: 'bukan-uuid' }, error: null })],
  ])('%s dilempar sebagai galat hulu yang dicoba lagi', (_name, response) => {
    expect(() => toSourceLookup(response)).toThrow(UpstreamError)
  })
})

describe('jawaban katalog', () => {
  const property = { name: 'Padma', address: 'Jalan Melati 12', city: 'Bali' }

  test('properti dengan kontak', () => {
    expect(
      toProperty(ok({ data: { ...property, phone: '+62 1', email: 'a@b.example' }, error: null })),
    ).toEqual({ ...property, phone: '+62 1', email: 'a@b.example' })
  })

  test('properti tanpa kontak tidak diberi kontak kosong', () => {
    expect(toProperty(ok({ data: property, error: null }))).toEqual(property)
  })

  test('404 berarti belum terpetakan', () => {
    expect(toProperty(notFound)).toBeUndefined()
  })

  test('jawaban rusak dilempar', () => {
    expect(() => toProperty({ status: 500, body: {} })).toThrow(UpstreamError)
  })
})

describe('alamat yang dipanggil', () => {
  function recording(response: HttpResponse): Transport & { readonly urls: string[] } {
    const urls: string[] = []
    return Object.assign(
      async (url: string) => {
        urls.push(url)
        return await Promise.resolve(response)
      },
      { urls },
    )
  }

  test('booking-service lewat rute internal', async () => {
    const transport = recording(notFound)

    await createHttpBookingDirectory('http://booking', transport).voucherSource(BOOKING_ID)

    expect(transport.urls).toEqual([
      `http://booking/internal/bookings/${BOOKING_ID}/voucher-source`,
    ])
  })

  test('pengenal supplier di-encode, bukan disisipkan mentah', async () => {
    const transport = recording(notFound)

    await createHttpPropertyDirectory('http://search', transport).bySupplier('SKY', 'a/b c')

    expect(transport.urls).toEqual([
      'http://search/internal/catalog/properties/by-supplier/SKY/a%2Fb%20c',
    ])
  })
})
