import { describe, expect, test } from 'vitest'
import { outcomeOf, stagesOf } from './timeline'
import { BOOKING_STATUSES, type BookingStatus, type BookingStatusView } from './types'

function view(
  status: BookingStatus,
  overrides: Partial<BookingStatusView> = {},
): BookingStatusView {
  return {
    id: 'b-1',
    status,
    isFinal: ['CONFIRMED', 'REFUNDED', 'CANCELLED', 'EXPIRED', 'NEEDS_REVIEW'].includes(status),
    version: 4,
    updatedAt: '2026-10-06T10:00:00.000Z',
    heldUntil: null,
    supplierRef: null,
    failureReason: null,
    refund: null,
    review: null,
    cancellation: null,
    saga: null,
    serverTime: '2026-10-06T10:00:00.000Z',
    ...overrides,
  }
}

const states = (status: BookingStatus, overrides?: Partial<BookingStatusView>) =>
  stagesOf(view(status, overrides)).map((stage) => stage.state)

describe('tahapan pemesanan', () => {
  test('menunggu supplier: pembayaran selesai, konfirmasi sedang berjalan', () => {
    expect(states('PAID')).toEqual(['done', 'current', 'pending', 'pending'])
  })

  test('terkonfirmasi: kode pemesanan supplier ditampilkan, voucher menyusul', () => {
    const stages = stagesOf(view('CONFIRMED', { supplierRef: 'SKY-BK-7' }))

    expect(stages.map((stage) => stage.state)).toEqual(['done', 'done', 'done', 'current'])
    expect(stages[2]?.detail).toBe('Kode pemesanan SKY-BK-7')
  })

  test('gagal setelah pembayaran: konfirmasi berhenti, pembayaran tetap tercatat diterima', () => {
    expect(states('FAILED')).toEqual(['done', 'stopped', 'pending', 'pending'])
    expect(states('REFUNDED')).toEqual(['done', 'stopped', 'pending', 'pending'])
    expect(states('NEEDS_REVIEW')).toEqual(['done', 'stopped', 'pending', 'pending'])
  })

  test('kembali dari halaman bayar sebelum kabarnya tiba', () => {
    expect(states('HELD')).toEqual(['current', 'pending', 'pending', 'pending'])
  })

  test('berakhir tanpa pembayaran', () => {
    expect(states('EXPIRED')[0]).toBe('stopped')
    expect(states('CANCELLED')[0]).toBe('stopped')
  })
})

describe('pesan untuk pengguna', () => {
  test.each(BOOKING_STATUSES)('%s punya kalimatnya sendiri', (status) => {
    const outcome = outcomeOf(view(status))

    expect(outcome.title.length).toBeGreaterThan(0)
    expect(outcome.body.length).toBeGreaterThan(0)
  })

  test.each(['PAID', 'FAILED', 'REFUNDED', 'NEEDS_REVIEW'] as const)(
    '%s — setelah pembayaran — selalu menyebut keadaan uang pengguna',
    (status) => {
      expect(outcomeOf(view(status)).money).toBeDefined()
    },
  )

  test('pembatalan oleh pengguna tidak disebut "tidak ada dana yang ditagih" (Step 25)', () => {
    const cancellation = {
      step: 'done' as const,
      refund: { amountMinor: 1_221_000, currency: 'IDR' as const },
      percent: 50,
      requestedAt: '2026-10-06T10:00:00.000Z',
    }

    const refunded = outcomeOf(view('CANCELLED', { cancellation }))
    const nothing = outcomeOf(
      view('CANCELLED', {
        cancellation: { ...cancellation, refund: { amountMinor: 0, currency: 'IDR' }, percent: 0 },
      }),
    )

    expect(refunded.money).toMatch(/sudah dikirim/)
    expect(nothing.money).toMatch(/kebijakan pembatalan/)
    expect(refunded.money).not.toMatch(/tidak ada dana yang ditagih/i)
    expect(states('CANCELLED', { cancellation })).toEqual(['done', 'done', 'done', 'pending'])
  })

  test('pembatalan yang diperiksa manual berbicara soal pembatalan, bukan kamar', () => {
    const outcome = outcomeOf(view('NEEDS_REVIEW', { review: 'cancellation' }))

    expect(outcome.title).toMatch(/[Pp]embatalan/)
    expect(outcome.body).not.toMatch(/kepastian dari penyedia/)
  })

  test('NEEDS_REVIEW tidak berpura-pura berhasil maupun gagal', () => {
    const outcome = outcomeOf(view('NEEDS_REVIEW'))

    expect(outcome.tone).toBe('review')
    expect(outcome.body).toMatch(/memeriksa/)
    expect(outcome.title).not.toMatch(/gagal|berhasil|terkonfirmasi/i)
  })

  test('alasan kegagalan internal tidak pernah tampil', () => {
    const outcome = outcomeOf(
      view('FAILED', { failureReason: 'supplier menolak konfirmasi setelah tiga percobaan' }),
    )

    expect(JSON.stringify(outcome)).not.toContain('percobaan')
  })
})
