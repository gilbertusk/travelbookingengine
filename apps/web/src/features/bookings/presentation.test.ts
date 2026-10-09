import { describe, expect, test } from 'vitest'
import { BOOKING_STATUSES } from '@/features/booking/types'
import { formatDeadline, policyLines, statusOf, zoneLabel } from './presentation'
import type { BookingListItem, RefundQuote } from './types'

const IDR = (amountMinor: number) => ({ amountMinor, currency: 'IDR' as const })

function item(overrides: Partial<BookingListItem> = {}): BookingListItem {
  return {
    id: 'b-1',
    status: 'CONFIRMED',
    isFinal: true,
    propertyName: 'Villa Sawah Ubud',
    city: 'Denpasar',
    roomTypeName: 'Deluxe King',
    checkIn: '2026-11-10',
    checkOut: '2026-11-12',
    guests: 2,
    supplierRef: 'SKY-BK-1',
    total: IDR(2_442_000),
    refund: null,
    review: null,
    cancellation: null,
    ...overrides,
  }
}

const CANCELLATION = {
  step: 'done' as const,
  refund: IDR(1_221_000),
  percent: 50,
  requestedAt: '2026-11-07T03:00:00.000Z',
}

describe('status dengan kata-kata', () => {
  test.each(BOOKING_STATUSES)('%s punya label tertulis', (status) => {
    const label = statusOf(item({ status }))

    expect(label.label.length).toBeGreaterThan(0)
  })

  test('pembatalan oleh pengguna dibedakan dari pembatalan sebelum bayar', () => {
    expect(statusOf(item({ status: 'CANCELLED', cancellation: CANCELLATION }))).toMatchObject({
      label: 'Dibatalkan',
      money: 'refunded',
    })
    expect(statusOf(item({ status: 'CANCELLED' }))).toMatchObject({
      label: 'Dibatalkan',
      money: 'not_charged',
    })
    expect(
      statusOf(
        item({
          status: 'CANCELLED',
          cancellation: { ...CANCELLATION, refund: IDR(0), percent: 0 },
        }),
      ),
    ).toMatchObject({ money: 'nothing_back' })
  })

  test('pembatalan yang berjalan menyebut langkahnya', () => {
    const waitingSupplier = statusOf(
      item({ status: 'CANCELLING', cancellation: { ...CANCELLATION, step: 'supplier' } }),
    )
    const refunding = statusOf(
      item({ status: 'CANCELLING', cancellation: { ...CANCELLATION, step: 'refund' } }),
    )

    expect(waitingSupplier.label).toBe('Sedang dibatalkan')
    expect(refunding.label).toMatch(/dana sedang dikembalikan/)
  })

  test('pemeriksaan manual tidak berbunyi berhasil maupun gagal', () => {
    const room = statusOf(item({ status: 'NEEDS_REVIEW', review: 'room' }))
    const cancellation = statusOf(item({ status: 'NEEDS_REVIEW', review: 'cancellation' }))

    expect(room).toMatchObject({ tone: 'review', label: 'Sedang diperiksa tim kami' })
    expect(cancellation.label).toBe('Pembatalan sedang diperiksa')
    for (const label of [room.label, cancellation.label]) {
      expect(label).not.toMatch(/berhasil|gagal|terkonfirmasi/i)
    }
  })

  test('refund kompensasi yang berjalan dan yang tuntas tidak disamakan', () => {
    expect(statusOf(item({ status: 'FAILED', refund: 'pending' })).money).toBe('refund_pending')
    expect(statusOf(item({ status: 'REFUNDED', refund: 'completed' })).money).toBe('refunded')
  })
})

describe('tenggat sebagai tanggal dan jam konkret di zona properti', () => {
  test('zona Indonesia memakai singkatannya', () => {
    expect(zoneLabel('Asia/Jakarta', new Date('2026-11-06T16:00:00Z'))).toBe('WIB')
    expect(zoneLabel('Asia/Makassar', new Date('2026-11-06T16:00:00Z'))).toBe('WITA')
  })

  test('zona lain disebut dengan kotanya, bukan selisih GMT', () => {
    expect(zoneLabel('Asia/Tokyo', new Date('2026-11-06T16:00:00Z'))).toBe('waktu Tokyo')
    expect(zoneLabel('America/New_York', new Date('2026-11-06T16:00:00Z'))).toBe('waktu New York')
  })

  test('tenggat tengah malam ditampilkan sebagai menit terakhir hari sebelumnya', () => {
    // 6 Nov 16.00 UTC = 7 Nov 00.00 WITA. "Sampai 7 Nov pukul 00.00" dibaca
    // banyak orang sebagai sepanjang 7 November.
    expect(formatDeadline('2026-11-06T16:00:00.000Z', 'Asia/Makassar')).toBe(
      'Jumat, 6 Nov 2026 pukul 23.59 WITA',
    )
  })

  test('jam di zona properti, bukan di zona peramban', () => {
    expect(formatDeadline('2026-11-06T15:00:00.000Z', 'Asia/Tokyo')).toBe(
      'Jumat, 6 Nov 2026 pukul 23.59 waktu Tokyo',
    )
  })
})

describe('kebijakan pembatalan sebagai kalimat', () => {
  const quote: RefundQuote = {
    refund: IDR(2_442_000),
    percent: 100,
    until: '2026-11-06T16:00:00.000Z',
    next: { percent: 50 },
    nothingBack: null,
    tiers: [
      { percent: 100, until: '2026-11-06T16:00:00.000Z' },
      { percent: 50, until: '2026-11-08T16:00:00.000Z' },
      { percent: 0, until: '2026-11-09T16:00:00.000Z' },
    ],
    checkInStartsAt: '2026-11-09T16:00:00.000Z',
    timeZone: 'Asia/Makassar',
  }

  test('setiap jenjang disebut dengan tenggatnya', () => {
    expect(policyLines(quote)).toEqual([
      'Gratis dibatalkan sampai Jumat, 6 Nov 2026 pukul 23.59 WITA.',
      'Dana kembali 50% bila dibatalkan sampai Minggu, 8 Nov 2026 pukul 23.59 WITA.',
      'Setelah itu, tidak ada dana yang kembali.',
    ])
  })

  test('rate non-refundable disebut terang-terangan', () => {
    expect(
      policyLines({ ...quote, tiers: [{ percent: 0, until: quote.checkInStartsAt }] }),
    ).toEqual(['Rate ini tidak dapat dikembalikan bila dibatalkan.'])
  })

  test('gratis sampai tanggal masuk tidak menyebut jenjang nol', () => {
    expect(
      policyLines({ ...quote, tiers: [{ percent: 100, until: quote.checkInStartsAt }] }),
    ).toEqual(['Gratis dibatalkan sampai Senin, 9 Nov 2026 pukul 23.59 WITA.'])
  })
})
