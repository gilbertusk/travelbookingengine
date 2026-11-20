import { EVENT_PAYLOADS } from '@tbe/event-contracts'
import { describe, expect, test } from 'vitest'
import { SUPPLIER_CODES, needsSupplier } from './facts.js'

describe('fakta analitik', () => {
  test('kode supplier sama persis dengan kontrak peristiwa', () => {
    // Domain analitik memegang salinannya sendiri supaya tidak bergantung pada
    // Zod. Supplier baru di kontrak tanpa di sini akan dibuang sebagai
    // "tidak dikenal" oleh penyimpan — uji ini menolaknya lebih dulu.
    expect([...SUPPLIER_CODES]).toEqual(EVENT_PAYLOADS['booking.created'].shape.supplier.options)
  })

  test('hanya perubahan harga dan kegagalan yang membutuhkan pemetaan supplier', () => {
    expect(needsSupplier({ kind: 'price_changed', bookingId: 'b' })).toBe(true)
    expect(
      needsSupplier({
        kind: 'booking_failed',
        bookingId: 'b',
        stage: 'payment',
        reason: 'x',
        requiresManualReview: false,
      }),
    ).toBe(true)
    expect(needsSupplier({ kind: 'booking_held', bookingId: 'b' })).toBe(false)
  })
})
