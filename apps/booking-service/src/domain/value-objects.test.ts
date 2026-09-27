import { money } from '@tbe/money'
import { describe, expect, test } from 'vitest'
import { draftChange, idr, sampleGuests, samplePrice, sampleStay, T0 } from '../testing/builders.js'
import { createBooking, INITIAL_VERSION } from './create-booking.js'
import { guestDetails, MAX_GUESTS } from './guest-details.js'
import { parseIdempotencyKey } from './idempotency-key.js'
import { isSameAmount, priceBreakdown, type BookingLineItem } from './price.js'
import { MAX_NIGHTS, nights, parseLocalDate, stayDates } from './stay-dates.js'

describe('tanggal menginap (NFR-09)', () => {
  test('tanggal kalender yang sah diterima apa adanya', () => {
    expect(parseLocalDate('2026-11-10')).toBe('2026-11-10')
  })

  test.each(['2026-02-31', '2026-13-01', '2026-11-10T00:00:00Z', '10/11/2026', '2026-1-5', ''])(
    '%j bukan tanggal kalender',
    (value) => {
      expect(parseLocalDate(value)).toBeUndefined()
    },
  )

  test('29 Februari hanya ada pada tahun kabisat', () => {
    expect(parseLocalDate('2028-02-29')).toBe('2028-02-29')
    expect(parseLocalDate('2026-02-29')).toBeUndefined()
  })

  test('check-out wajib setelah check-in', () => {
    const result = stayDates({ checkIn: '2026-11-10', checkOut: '2026-11-10' })

    expect(result).toEqual({ ok: false, error: { kind: 'check_out_not_after_check_in' } })
  })

  test.each([
    ['checkIn', { checkIn: '2026-11-31', checkOut: '2026-12-02' }],
    ['checkOut', { checkIn: '2026-11-10', checkOut: 'besok' }],
  ] as const)('tanggal %s yang tidak sah disebutkan', (field, input) => {
    expect(stayDates(input)).toEqual({ ok: false, error: { kind: 'invalid_date', field } })
  })

  test('menginap melebihi batas malam ditolak', () => {
    const result = stayDates({ checkIn: '2026-11-01', checkOut: '2026-12-02' })

    expect(result).toEqual({
      ok: false,
      error: { kind: 'too_many_nights', nights: MAX_NIGHTS + 1 },
    })
  })

  test('menginap tepat pada batas malam diterima', () => {
    expect(stayDates({ checkIn: '2026-11-01', checkOut: '2026-12-01' }).ok).toBe(true)
  })

  test('menginap yang melintasi pergantian jam musim panas tetap bilangan malam bulat', () => {
    // 1 November 2026 adalah akhir jam musim panas di Los Angeles — zona proses
    // uji ini (vitest.config.ts). Perhitungan berbasis zona lokal memberi 25
    // jam untuk satu malam di sini.
    const stay = stayDates({ checkIn: '2026-10-31', checkOut: '2026-11-02' })

    expect(stay.ok && nights(stay.value)).toBe(2)
  })
})

describe('tamu', () => {
  test('nama dan surel dirapikan', () => {
    const result = guestDetails({ fullName: '  Sari  ', email: ' sari@example.com ', count: 1 })

    expect(result).toEqual({
      ok: true,
      value: { leadGuest: { fullName: 'Sari', email: 'sari@example.com' }, count: 1 },
    })
  })

  test.each(['', '   ', 'x'.repeat(121)])('nama %j ditolak', (fullName) => {
    expect(guestDetails({ fullName, email: 'a@b.co', count: 1 }).ok).toBe(false)
  })

  test.each(['sari', 'sari@', 'sari@example', 'sa ri@example.com'])('surel %j ditolak', (email) => {
    expect(guestDetails({ fullName: 'Sari', email, count: 1 })).toEqual({
      ok: false,
      error: { kind: 'invalid_email' },
    })
  })

  test.each([0, -1, 1.5, MAX_GUESTS + 1])('jumlah tamu %d ditolak', (count) => {
    expect(guestDetails({ fullName: 'Sari', email: 'a@b.co', count })).toEqual({
      ok: false,
      error: { kind: 'invalid_count', count },
    })
  })
})

describe('kunci idempotensi (FR-18)', () => {
  test.each([
    '0f8e2c4a-1b3d-4e5f-9a7b-6c5d4e3f2a1b',
    '01J9ZQ3K8M2N4P6R8T0V2X4Z6B',
    'a'.repeat(128),
  ])('%s diterima', (value) => {
    expect(parseIdempotencyKey(value)).toBe(value)
  })

  test.each([
    'abc',
    'a'.repeat(15),
    'a'.repeat(129),
    'kunci dengan spasi!!',
    'baris\nbaru-0123456789',
  ])('%j ditolak', (value) => {
    expect(parseIdempotencyKey(value)).toBeUndefined()
  })
})

describe('rincian harga', () => {
  const night = (amountMinor: number): BookingLineItem => ({
    kind: 'room_night',
    description: 'Malam',
    amount: idr(amountMinor),
  })

  test('total adalah jumlah seluruh baris', () => {
    expect(samplePrice().total).toEqual(idr(2_220_000))
  })

  test('rincian tanpa malam kamar ditolak', () => {
    const result = priceBreakdown([{ kind: 'tax', description: 'PPN', amount: idr(1) }])

    expect(result).toEqual({ ok: false, error: { kind: 'no_room_night' } })
  })

  test('rincian kosong ditolak', () => {
    expect(priceBreakdown([])).toEqual({ ok: false, error: { kind: 'no_room_night' } })
  })

  test('baris bermata uang campuran ditolak tanpa melempar', () => {
    const result = priceBreakdown([
      night(100),
      { kind: 'fee', description: 'Biaya', amount: money(5, 'USD') },
    ])

    expect(result).toEqual({ ok: false, error: { kind: 'mixed_currency' } })
  })

  test('baris negatif ditolak dan disebutkan posisinya', () => {
    const result = priceBreakdown([night(100), night(-10)])

    expect(result).toEqual({ ok: false, error: { kind: 'negative_line_item', index: 1 } })
  })

  test('total nol ditolak', () => {
    expect(priceBreakdown([night(0)])).toEqual({ ok: false, error: { kind: 'zero_total' } })
  })

  test('mengubah larik masukan tidak mengubah rincian yang sudah dibuat', () => {
    const items = [night(100)]
    const result = priceBreakdown(items)
    items.push(night(900))

    expect(result.ok && result.value.lineItems).toHaveLength(1)
  })

  test('kesamaan nilai membandingkan mata uang tanpa melempar', () => {
    expect(isSameAmount(idr(100), idr(100))).toBe(true)
    expect(isSameAmount(idr(100), idr(101))).toBe(false)
    expect(isSameAmount(idr(100), money(100, 'USD'))).toBe(false)
  })
})

describe('pembuatan pemesanan', () => {
  test('pemesanan baru berada di DRAFT dengan versi pertama', () => {
    const { booking } = draftChange()

    expect(booking.status).toBe('DRAFT')
    expect(booking.version).toBe(INITIAL_VERSION)
    expect(booking.createdAt).toEqual(T0)
    expect(booking.updatedAt).toEqual(T0)
  })

  test('peristiwa pembuatan membawa seluruh isi booking.created', () => {
    const { booking, event } = draftChange()

    expect(event).toEqual({
      type: 'BookingCreated',
      bookingId: booking.id,
      version: 1,
      occurredAt: T0,
      userId: booking.userId,
      supplier: 'SKY',
      propertyId: 'prop-bali-001',
      ratePlanRef: 'SKY:RP-DLX-BB',
      stay: sampleStay(),
      guestCount: 2,
      amount: idr(2_220_000),
    })
  })

  test.each(['id', 'userId', 'propertyId', 'ratePlanRef'] as const)(
    '%s kosong ditolak',
    (field) => {
      const { booking } = draftChange()

      const result = createBooking({
        id: booking.id,
        userId: booking.userId,
        supplier: booking.supplier,
        propertyId: booking.propertyId,
        ratePlanRef: booking.ratePlanRef,
        stay: sampleStay(),
        guests: sampleGuests(),
        price: samplePrice(),
        idempotencyKey: booking.idempotencyKey,
        at: T0,
        [field]: ' ',
      })

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.rule).toBe('blank_field')
      expect(result.error.message).toBe(`Bidang ${field} kosong`)
    },
  )
})
