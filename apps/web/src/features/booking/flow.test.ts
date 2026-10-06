import { describe, expect, test } from 'vitest'
import { ApiError } from '@/lib/api-error'
import { decide, stepForError } from './flow'
import { sampleBooking } from '@/testing/booking'

const IDR = (amountMinor: number) => ({ amountMinor, currency: 'IDR' as const })

const apiError = (code: string, kind: ApiError['kind'] = 'client') =>
  new ApiError({ kind, status: 409, code, message: 'x' })

describe('keputusan menurut keadaan pemesanan', () => {
  test('harga terverifikasi tanpa perubahan: tahan kamarnya', () => {
    expect(decide(sampleBooking())).toEqual({ step: 'do_hold' })
  })

  test('harga berubah: dialog dengan harga lama, baru, dan selisih (US-02)', () => {
    const booking = sampleBooking({
      priceCheck: {
        outcome: 'changed',
        previous: IDR(2_442_000),
        current: IDR(2_600_000),
        difference: IDR(158_000),
      },
    })

    expect(decide(booking)).toEqual({
      step: 'rate_changed',
      booking,
      previous: IDR(2_442_000),
      current: IDR(2_600_000),
      difference: IDR(158_000),
    })
  })

  test('harga disetujui tetapi belum terverifikasi ulang: price check lagi', () => {
    expect(decide(sampleBooking({ priceCheck: { outcome: 'awaiting_recheck' } }))).toEqual({
      step: 'do_recheck',
    })
    expect(decide(sampleBooking({ priceCheck: null }))).toEqual({ step: 'do_recheck' })
    expect(decide(sampleBooking({ status: 'DRAFT', priceCheck: null }))).toEqual({
      step: 'do_recheck',
    })
  })

  test('rate plan hilang di supplier: jalan keluar, bukan galat', () => {
    expect(decide(sampleBooking({ priceCheck: { outcome: 'unavailable' } }))).toEqual({
      step: 'unavailable',
      reason: 'rate_gone',
    })
    expect(decide(sampleBooking({ status: 'CANCELLED', priceCheck: null }))).toEqual({
      step: 'unavailable',
      reason: 'rate_gone',
    })
  })

  test('dimuat ulang di tengah alur: HELD melanjutkan hitung mundur', () => {
    const booking = sampleBooking({ status: 'HELD', heldUntil: '2026-10-06T10:15:00.000Z' })

    expect(decide(booking)).toEqual({ step: 'held', booking })
  })

  test.each(['PAID', 'CONFIRMED', 'FAILED', 'REFUNDED', 'NEEDS_REVIEW'] as const)(
    '%s sudah melewati pembayaran: ke halaman status',
    (status) => {
      expect(decide(sampleBooking({ status })).step).toBe('paid')
    },
  )

  test('EXPIRED', () => {
    expect(decide(sampleBooking({ status: 'EXPIRED' }))).toEqual({ step: 'expired' })
  })
})

describe('galat menjadi layar dengan jalan keluar', () => {
  test('kamar habis dan rate plan hilang punya layarnya sendiri', () => {
    expect(stepForError(apiError('SOLD_OUT'), 'hold')).toEqual({
      step: 'unavailable',
      reason: 'sold_out',
    })
    expect(stepForError(apiError('RATE_UNAVAILABLE'), 'check')).toEqual({
      step: 'unavailable',
      reason: 'rate_gone',
    })
  })

  test('hold yang habis saat membuka pembayaran', () => {
    expect(stepForError(apiError('HOLD_EXPIRED'), 'pay')).toEqual({ step: 'expired' })
  })

  test.each(['PRICE_CHANGED', 'HOLD_IN_PROGRESS', 'ALREADY_PAID', 'NOT_PAYABLE'])(
    '%s ditindaklanjuti pemanggil, tidak ditampilkan',
    (code) => {
      expect(stepForError(apiError(code), 'hold')).toBeUndefined()
    },
  )

  test('galat jaringan: coba lagi aksi yang sama, dan katakan belum ada yang ditagih', () => {
    const step = stepForError(apiError('NETWORK_ERROR', 'network'), 'hold')

    expect(step).toMatchObject({ step: 'failed', retry: 'hold' })
    if (step?.step !== 'failed') return
    expect(step.message).toMatch(/belum ada yang ditagih/i)
  })

  test.each(['check', 'hold', 'pay'] as const)(
    'galat server saat %s menyebut bahwa belum ada yang ditagih',
    (action) => {
      const step = stepForError(apiError('SUPPLIER_UNAVAILABLE', 'server'), action)

      expect(step).toMatchObject({ step: 'failed', retry: action })
      if (step?.step !== 'failed') return
      expect(step.message).toMatch(/belum ada yang ditagih/i)
    },
  )

  test('sesi berakhir diberi tahu apa adanya', () => {
    const step = stepForError(apiError('SESSION_EXPIRED', 'unauthorized'), 'check')

    expect(step).toMatchObject({ step: 'failed' })
    if (step?.step !== 'failed') return
    expect(step.message).toMatch(/Masuk kembali/)
  })

  test('penyedia pembayaran menolak: kamar masih tertahan, dapat dicoba lagi', () => {
    expect(stepForError(apiError('PAYMENT_REJECTED'), 'pay')).toMatchObject({
      step: 'failed',
      retry: 'pay',
    })
  })

  test('galat yang bukan ApiError tetap punya jalan keluar', () => {
    expect(stepForError(new Error('x'), 'check')).toMatchObject({ step: 'failed', retry: 'check' })
  })
})
