import { money } from '@tbe/money'
import { describe, expect, test } from 'vitest'
import {
  PAYMENT_ID,
  REFUND_ID,
  draft,
  idr,
  inState,
  minutesAfter,
  narrow,
  priceChanged,
  samplePrice,
  step,
  validCommand,
  SAMPLE_POLICY,
} from '../testing/builders.js'
import type { Booking } from './booking.js'
import type { BookingCommand } from './commands.js'
import { BookingRuleError, type BookingRule } from './errors.js'
import { priceBreakdown } from './price.js'
import { applyCommand } from './transitions.js'

/**
 * Aturan tiap perintah — hal yang TIDAK dapat dinyatakan tabel transisi.
 *
 * Tabel memutuskan apakah sebuah perintah bermakna pada sebuah keadaan. Berkas
 * ini membuktikan bahwa perintah yang bermakna tetap ditolak ketika datanya
 * melanggar aturan, dengan galat yang menyebut aturan mana.
 */

function expectRule(booking: Booking, command: BookingCommand, rule: BookingRule): void {
  const snapshot = structuredClone(booking)
  const result = applyCommand(booking, command)

  expect(result.ok).toBe(false)
  if (result.ok) return
  expect(result.error).toBeInstanceOf(BookingRuleError)
  expect(result.error.kind).toBe('rule_violation')
  if (!(result.error instanceof BookingRuleError)) return
  expect(result.error.rule).toBe(rule)
  expect(result.error.code).toBe('BOOKING_RULE_VIOLATION')
  expect(result.error.httpStatus).toBe(409)
  // Penolakan tidak pernah mengubah pemesanan yang diterima.
  expect(booking).toEqual(snapshot)
}

describe('price check dan persetujuan harga (FR-13, FR-14, US-02)', () => {
  test('harga supplier yang sama menghasilkan PRICE_CHECKED terverifikasi', () => {
    const booking = draft()

    const result = applyCommand(booking, validCommand(booking, 'verifyPrice'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const next = narrow(result.value.booking, 'PRICE_CHECKED')
    expect(next.priceCheck).toEqual({ kind: 'verified' })
    expect(result.value.event).toMatchObject({ type: 'PriceVerified', amount: idr(2_220_000) })
  })

  test('harga yang sama mengadopsi rincian terverifikasi tanpa mengubah totalnya', () => {
    const booking = draft()
    const verified = priceBreakdown([
      { kind: 'room_night', description: 'Kamar, 2 malam', amount: idr(2_000_000) },
      { kind: 'tax', description: 'PPN 11%', amount: idr(220_000) },
    ])
    if (!verified.ok) throw new Error('persiapan gagal')

    const next = step(booking, {
      type: 'verifyPrice',
      at: minutesAfter(booking.updatedAt, 1),
      verified: verified.value,
      policy: SAMPLE_POLICY,
    })

    expect(next.price).toEqual(verified.value)
    expect(next.price.total).toEqual(booking.price.total)
  })

  test('harga berubah menghentikan alur dan membawa harga lama serta baru', () => {
    const booking = priceChanged(1_100_000)

    expect(booking.priceCheck).toEqual({ kind: 'changed', quoted: samplePrice(1_100_000) })
    // Harga yang disetujui BELUM berubah. Menagih sekarang berarti menagih
    // harga lama; yang baru hanya boleh ditagih setelah persetujuan eksplisit.
    expect(booking.price.total).toEqual(idr(2_220_000))
  })

  test('peristiwa perubahan harga membawa kedua nilai', () => {
    const booking = draft()

    const result = applyCommand(booking, {
      type: 'verifyPrice',
      at: minutesAfter(booking.updatedAt, 1),
      verified: samplePrice(1_100_000),
      policy: SAMPLE_POLICY,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.event).toMatchObject({
      type: 'PriceChanged',
      previousAmount: idr(2_220_000),
      newAmount: idr(2_442_000),
    })
  })

  test('harga dalam mata uang lain adalah perubahan harga, bukan galat', () => {
    const booking = draft()
    const usd = priceBreakdown([
      { kind: 'room_night', description: 'Malam', amount: money(2_220_000, 'USD') },
    ])
    if (!usd.ok) throw new Error('persiapan gagal')
    const inUsd = usd.value

    const result = applyCommand(booking, {
      type: 'verifyPrice',
      at: minutesAfter(booking.updatedAt, 1),
      verified: inUsd,
      policy: SAMPLE_POLICY,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.event.type).toBe('PriceChanged')
  })

  test('price check ulang saat perubahan menunggu persetujuan ditolak', () => {
    const booking = priceChanged()

    expectRule(booking, validCommand(booking, 'verifyPrice'), 'price_awaiting_approval')
  })

  test('hold saat perubahan harga menunggu persetujuan ditolak', () => {
    const booking = priceChanged()

    expectRule(booking, validCommand(booking, 'hold'), 'price_awaiting_approval')
  })

  test('persetujuan memindahkan harga yang disetujui ke harga baru', () => {
    const booking = priceChanged(1_100_000)

    const accepted = narrow(step(booking, validCommand(booking, 'acceptPrice')), 'PRICE_CHECKED')

    expect(accepted.price).toEqual(samplePrice(1_100_000))
    expect(accepted.priceCheck).toEqual({ kind: 'accepted' })
  })

  /**
   * Step 17: "persetujuan harga baru menghasilkan permintaan price check ulang.
   * Harga bisa berubah lagi." Tuntutan itu ditegakkan di sini, bukan diingat
   * pemanggil: hold langsung setelah persetujuan ditolak.
   */
  test('hold setelah persetujuan tanpa price check ulang ditolak', () => {
    const booking = priceChanged()
    const accepted = step(booking, validCommand(booking, 'acceptPrice'))

    expectRule(accepted, validCommand(accepted, 'hold'), 'price_not_reverified')
  })

  test('price check ulang setelah persetujuan membuka jalan ke hold', () => {
    const booking = priceChanged(1_100_000)
    const accepted = step(booking, validCommand(booking, 'acceptPrice'))
    const reverified = step(accepted, {
      type: 'verifyPrice',
      at: minutesAfter(accepted.updatedAt, 1),
      verified: samplePrice(1_100_000),
      policy: SAMPLE_POLICY,
    })

    const held = step(reverified, validCommand(reverified, 'hold'))

    expect(held.status).toBe('HELD')
    expect(held.price.total).toEqual(idr(2_442_000))
  })

  test('harga yang berubah lagi setelah persetujuan kembali menunggu persetujuan', () => {
    const booking = priceChanged(1_100_000)
    const accepted = step(booking, validCommand(booking, 'acceptPrice'))

    const again = applyCommand(accepted, {
      type: 'verifyPrice',
      at: minutesAfter(accepted.updatedAt, 1),
      verified: samplePrice(1_200_000),
      policy: SAMPLE_POLICY,
    })

    expect(again.ok).toBe(true)
    if (!again.ok) return
    // Perbandingan terhadap harga yang BARU disetujui, bukan harga awal.
    expect(again.value.event).toMatchObject({
      type: 'PriceChanged',
      previousAmount: idr(2_442_000),
      newAmount: idr(2_664_000),
    })
  })

  test('persetujuan tanpa perubahan harga ditolak', () => {
    const booking = inState('PRICE_CHECKED')

    expectRule(booking, validCommand(booking, 'acceptPrice'), 'no_price_change')
  })
})

describe('kebijakan pembatalan dari price check (Step 25)', () => {
  test('menggantikan kebijakan di ketentuan tawaran dan menyimpan jadwalnya', () => {
    const booking = draft()

    const checked = step(booking, {
      type: 'verifyPrice',
      at: minutesAfter(booking.updatedAt, 1),
      verified: booking.price,
      policy: { refundable: false },
    })

    expect(checked.terms?.cancellationPolicy).toEqual({ refundable: false })
    expect(checked.terms?.roomTypeName).toBe(booking.terms?.roomTypeName)
    expect(checked.refundSchedule?.tiers).toEqual([{ minHoursBefore: 0, percent: 0 }])
  })

  test('pemesanan tanpa ketentuan tawaran tetap mendapat jadwal, tanpa ketentuan karangan', () => {
    const { terms, ...withoutTerms } = draft()
    expect(terms).toBeDefined()

    const checked = step(withoutTerms, {
      type: 'verifyPrice',
      at: minutesAfter(withoutTerms.updatedAt, 1),
      verified: withoutTerms.price,
      policy: SAMPLE_POLICY,
    })

    expect('terms' in checked).toBe(false)
    expect(checked.refundSchedule).toBeDefined()
  })
})

describe('hold', () => {
  test('hold membawa token supplier dan batas waktunya', () => {
    const booking = inState('HELD')

    const held = narrow(booking, 'HELD')
    expect(held.holdRef).toBe('sky-hold-001')
    expect(held.heldUntil.getTime()).toBeGreaterThan(held.updatedAt.getTime())
  })

  test('hold tanpa token supplier ditolak', () => {
    const booking = inState('PRICE_CHECKED')

    expectRule(booking, { ...validCommand(booking, 'hold'), holdRef: '  ' }, 'blank_field')
  })

  test('hold yang batas waktunya sudah lewat saat dibuat ditolak', () => {
    const booking = inState('PRICE_CHECKED')
    const command = validCommand(booking, 'hold')

    expectRule(booking, { ...command, heldUntil: command.at }, 'hold_window_invalid')
  })

  test('hold tidak dapat kedaluwarsa sebelum batas waktunya', () => {
    const booking = narrow(inState('HELD'), 'HELD')

    expectRule(
      booking,
      { type: 'expireHold', at: new Date(booking.heldUntil.getTime() - 1) },
      'hold_not_expired',
    )
  })

  test('hold kedaluwarsa tepat pada batas waktunya', () => {
    const booking = narrow(inState('HELD'), 'HELD')

    const expired = step(booking, { type: 'expireHold', at: booking.heldUntil })

    // Token hold tetap dibawa: pelepasan hold di supplier membutuhkannya
    // SETELAH keadaan berpindah.
    expect(narrow(expired, 'EXPIRED').holdRef).toBe(booking.holdRef)
  })
})

describe('uang: hanya harga yang disetujui yang boleh ditagih (G2)', () => {
  test('pembayaran dengan nilai berbeda ditolak', () => {
    const booking = inState('HELD')

    expectRule(
      booking,
      { ...validCommand(booking, 'recordPayment'), amount: idr(2_219_999) },
      'amount_mismatch',
    )
  })

  test('pembayaran dalam mata uang lain ditolak tanpa melempar', () => {
    const booking = inState('HELD')

    expectRule(
      booking,
      { ...validCommand(booking, 'recordPayment'), amount: money(2_220_000, 'USD') },
      'amount_mismatch',
    )
  })

  test('pembayaran tanpa pengenal ditolak', () => {
    const booking = inState('HELD')

    expectRule(booking, { ...validCommand(booking, 'recordPayment'), paymentId: '' }, 'blank_field')
  })

  test('pembayaran yang tiba setelah batas hold tetap diterima selama masih HELD', () => {
    const booking = narrow(inState('HELD'), 'HELD')

    const paid = step(booking, {
      ...validCommand(booking, 'recordPayment'),
      at: minutesAfter(booking.heldUntil, 5),
    })

    expect(narrow(paid, 'PAID').paymentId).toBe(PAYMENT_ID)
  })

  test('pembayaran pada hold yang sudah kedaluwarsa ditolak tabel', () => {
    const booking = inState('EXPIRED')

    const result = applyCommand(booking, validCommand(booking, 'recordPayment'))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('invalid_transition')
  })

  test('refund sebagian tidak menjadikan pemesanan REFUNDED', () => {
    const booking = inState('FAILED')

    expectRule(
      booking,
      { ...validCommand(booking, 'recordRefund'), amount: idr(1_000_000) },
      'amount_mismatch',
    )
  })

  test('refund tanpa pengenal ditolak', () => {
    const booking = inState('FAILED')

    expectRule(booking, { ...validCommand(booking, 'recordRefund'), refundId: ' ' }, 'blank_field')
  })
})

describe('konfirmasi, kegagalan, dan peninjauan', () => {
  test('CONFIRMED membawa booking reference supplier dan pembayarannya', () => {
    const confirmed = narrow(inState('CONFIRMED'), 'CONFIRMED')

    expect(confirmed.supplierRef).toBe('SKY-BK-778812')
    expect(confirmed.paymentId).toBe(PAYMENT_ID)
  })

  test('konfirmasi tanpa booking reference ditolak', () => {
    const booking = inState('PAID')

    expectRule(booking, { ...validCommand(booking, 'confirm'), supplierRef: '' }, 'blank_field')
  })

  test('kegagalan tanpa alasan ditolak', () => {
    const booking = inState('PAID')

    expectRule(booking, { ...validCommand(booking, 'fail'), reason: ' ' }, 'blank_field')
  })

  test('peninjauan tanpa alasan ditolak', () => {
    const booking = inState('FAILED')

    expectRule(booking, { ...validCommand(booking, 'requireReview'), reason: '' }, 'blank_field')
  })

  test('REFUNDED mempertahankan alasan kegagalan dan mencatat refund', () => {
    const refunded = narrow(inState('REFUNDED'), 'REFUNDED')

    expect(refunded.failure.reason).toContain('supplier menolak')
    expect(refunded.refundId).toBe(REFUND_ID)
  })

  test.each(['PAID', 'FAILED'] as const)('peninjauan dari %s mencatat keadaan asalnya', (from) => {
    const booking = inState(from)

    const review = narrow(step(booking, validCommand(booking, 'requireReview')), 'NEEDS_REVIEW')

    expect(review.review.from).toBe(from)
    expect(review.paymentId).toBe(PAYMENT_ID)
  })

  test('pembatalan mencatat alasannya', () => {
    const booking = inState('HELD')

    const cancelled = step(booking, {
      type: 'cancel',
      at: booking.updatedAt,
      reason: 'payment_failed',
    })

    expect(narrow(cancelled, 'CANCELLED').cancellation).toBe('payment_failed')
  })
})

describe('bidang milik keadaan sebelumnya tidak terbawa', () => {
  /**
   * Handler menyusun keadaan berikutnya dari bidang dasar, bukan dengan
   * menyebar pemesanan lama. Uji ini menangkap penyebaran yang lolos compiler
   * lewat jalur yang tidak memeriksa bidang berlebih.
   */
  test.each([
    ['PAID', ['holdRef', 'heldUntil']],
    ['CONFIRMED', ['holdRef', 'heldUntil', 'priceCheck']],
    ['CANCELLED', ['holdRef', 'heldUntil', 'priceCheck']],
    ['REFUNDED', ['holdRef', 'supplierRef']],
  ] as const)('%s tidak membawa %j', (status, fields) => {
    const booking = inState(status)

    for (const field of fields) expect(booking).not.toHaveProperty(field)
  })
})

describe('imutabilitas', () => {
  test('transisi tidak mengubah pemesanan yang diterima', () => {
    const booking = inState('PAID')
    const snapshot = structuredClone(booking)

    step(booking, validCommand(booking, 'confirm'))

    expect(booking).toEqual(snapshot)
  })
})
