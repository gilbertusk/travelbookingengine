import { money } from '@tbe/money'
import { describe, expect, test } from 'vitest'
import {
  inState,
  minutesAfter,
  narrow,
  refunding,
  REFUND_ID,
  sampleQuote,
  step,
  validCommand,
} from '../testing/builders.js'
import type { Booking } from './booking.js'
import type { BookingCommand } from './commands.js'
import { BookingRuleError } from './errors.js'
import { applyCommand } from './transitions.js'

/**
 * Aturan saga pembatalan (Step 25) yang tidak dapat dinyatakan tabel transisi:
 * langkah di DALAM CANCELLING, dan uang yang tidak boleh melebihi yang dibayar.
 */

function rule(booking: Booking, command: BookingCommand): string | undefined {
  const result = applyCommand(booking, command)
  if (result.ok) return undefined

  return result.error instanceof BookingRuleError ? result.error.rule : result.error.kind
}

/** CANCELLING pada langkah supplier, dengan nilai pengembalian tertentu. */
function cancellingWith(refundMinor: number) {
  const confirmed = inState('CONFIRMED')
  const at = minutesAfter(confirmed.updatedAt, 1)

  return narrow(
    step(confirmed, {
      type: 'requestCancellation',
      at,
      quote: sampleQuote(money(refundMinor, 'IDR')),
      replyBy: minutesAfter(at, 10),
    }),
    'CANCELLING',
  )
}

describe('permintaan pembatalan', () => {
  test('menyimpan persetujuan pengguna dan menunggu supplier lebih dulu', () => {
    const confirmed = inState('CONFIRMED')
    const command = validCommand(confirmed, 'requestCancellation')

    const cancelling = narrow(step(confirmed, command), 'CANCELLING')

    expect(cancelling.cancellationRequest).toEqual({
      refund: confirmed.price.total,
      percent: 100,
      requestedAt: command.at,
    })
    expect(cancelling.cancellationStage).toEqual({ step: 'supplier', deadlineAt: command.replyBy })
    // Booking reference yang dibatalkan tetap terbawa — supplier.cancel membutuhkannya.
    expect(cancelling.supplierRef).toBe('SKY-BK-778812')
  })

  test('peristiwanya membawa seluruh dasar perhitungan, termasuk zona waktu properti', () => {
    const confirmed = inState('CONFIRMED')
    const command = validCommand(confirmed, 'requestCancellation')

    const result = applyCommand(confirmed, command)

    expect(result.ok && result.value.event).toMatchObject({
      type: 'CancellationRequested',
      quote: { timeZone: 'Asia/Makassar', percent: 100 },
      replyBy: command.replyBy,
    })
  })

  test.each([
    ['melebihi pembayaran', money(2_220_001, 'IDR')],
    ['negatif', money(-1, 'IDR')],
    ['dalam mata uang lain', money(100, 'USD')],
  ])('pengembalian %s ditolak', (_name, refund) => {
    const confirmed = inState('CONFIRMED')
    const command = validCommand(confirmed, 'requestCancellation')

    expect(rule(confirmed, { ...command, quote: sampleQuote(refund) })).toBe(
      'refund_exceeds_payment',
    )
  })

  test('batas menunggu supplier yang sudah lewat ditolak', () => {
    const confirmed = inState('CONFIRMED')
    const command = validCommand(confirmed, 'requestCancellation')

    expect(rule(confirmed, { ...command, replyBy: command.at })).toBe('deadline_in_past')
  })
})

describe('supplier membatalkan', () => {
  test('pengembalian yang wajib dikirim berpindah ke langkah refund', () => {
    const cancelling = inState('CANCELLING')
    const command = validCommand(cancelling, 'confirmSupplierCancellation')

    const next = narrow(step(cancelling, command), 'CANCELLING')

    expect(next.cancellationStage).toEqual({ step: 'refund', deadlineAt: command.refundBy })
    expect(next.cancellationRequest).toEqual(narrow(cancelling, 'CANCELLING').cancellationRequest)
  })

  test('tanpa dana yang kembali tidak ada refund untuk ditunggu', () => {
    const cancelling = cancellingWith(0)

    expect(rule(cancelling, validCommand(cancelling, 'confirmSupplierCancellation'))).toBe(
      'refund_due_mismatch',
    )
  })

  test('jawaban supplier yang kedua ditolak', () => {
    const awaitingRefund = refunding()

    expect(rule(awaitingRefund, validCommand(awaitingRefund, 'confirmSupplierCancellation'))).toBe(
      'cancellation_stage_mismatch',
    )
  })

  test('batas menunggu refund yang sudah lewat ditolak', () => {
    const cancelling = inState('CANCELLING')
    const command = validCommand(cancelling, 'confirmSupplierCancellation')

    expect(rule(cancelling, { ...command, refundBy: command.at })).toBe('deadline_in_past')
  })
})

describe('pembatalan tuntas', () => {
  test('refund yang tuntas menutup pembatalan dengan pengenal refundnya', () => {
    const awaitingRefund = refunding()

    const cancelled = narrow(
      step(awaitingRefund, validCommand(awaitingRefund, 'completeCancellation')),
      'CANCELLED',
    )

    expect(cancelled).toMatchObject({
      cancellation: 'user_request',
      paymentId: awaitingRefund.paymentId,
      supplierRef: awaitingRefund.supplierRef,
      cancellationSettlement: { kind: 'refunded', refundId: REFUND_ID },
    })
  })

  test('pembatalan setelah tenggat tuntas tanpa refund, langsung dari jawaban supplier', () => {
    const cancelling = cancellingWith(0)
    const command: BookingCommand = {
      type: 'completeCancellation',
      at: minutesAfter(cancelling.updatedAt, 1),
      settlement: { kind: 'nothing_due' },
    }

    const cancelled = narrow(step(cancelling, command), 'CANCELLED')

    expect(cancelled.cancellationSettlement).toEqual({ kind: 'nothing_due' })
    expect(cancelled.cancellationRequest?.refund).toEqual(money(0, 'IDR'))
  })

  test('tanpa refund tidak dapat ditutup bila ada dana yang wajib kembali', () => {
    const cancelling = inState('CANCELLING')
    const command: BookingCommand = {
      type: 'completeCancellation',
      at: minutesAfter(cancelling.updatedAt, 1),
      settlement: { kind: 'nothing_due' },
    }

    expect(rule(cancelling, command)).toBe('refund_due_mismatch')
  })

  test('tanpa refund tidak dapat ditutup setelah refund dikirim', () => {
    const awaitingRefund = refunding()
    const command: BookingCommand = {
      type: 'completeCancellation',
      at: minutesAfter(awaitingRefund.updatedAt, 1),
      settlement: { kind: 'nothing_due' },
    }

    expect(rule(awaitingRefund, command)).toBe('cancellation_stage_mismatch')
  })

  test('refund yang tiba sebelum supplier membatalkan ditolak', () => {
    // Uang tidak pernah kembali untuk kamar yang mungkin masih terpesan.
    const cancelling = inState('CANCELLING')

    expect(rule(cancelling, validCommand(cancelling, 'completeCancellation'))).toBe(
      'cancellation_stage_mismatch',
    )
  })

  test('refund dengan nilai lain bukan penyelesaian pembatalan ini', () => {
    const awaitingRefund = refunding()
    const command = validCommand(awaitingRefund, 'completeCancellation')

    expect(
      rule(awaitingRefund, {
        ...command,
        settlement: { kind: 'refunded', refundId: REFUND_ID, amount: money(1, 'IDR') },
      }),
    ).toBe('amount_mismatch')
  })

  test('refund tanpa pengenal ditolak', () => {
    const awaitingRefund = refunding()
    const command = validCommand(awaitingRefund, 'completeCancellation')

    expect(
      rule(awaitingRefund, {
        ...command,
        settlement: {
          kind: 'refunded',
          refundId: ' ',
          amount: awaitingRefund.cancellationRequest.refund,
        },
      }),
    ).toBe('blank_field')
  })
})

describe('supplier gagal membatalkan', () => {
  test('pemesanan kembali terkonfirmasi dengan booking reference yang sama', () => {
    const cancelling = inState('CANCELLING')

    const restored = narrow(
      step(cancelling, validCommand(cancelling, 'restoreConfirmation')),
      'CONFIRMED',
    )

    expect(restored.supplierRef).toBe('SKY-BK-778812')
    expect(restored.paymentId).toBe(narrow(cancelling, 'CANCELLING').paymentId)
  })

  test('tidak ada jalan kembali setelah kamar lepas di supplier', () => {
    const awaitingRefund = refunding()

    expect(rule(awaitingRefund, validCommand(awaitingRefund, 'restoreConfirmation'))).toBe(
      'cancellation_stage_mismatch',
    )
  })

  test('alasan kosong ditolak', () => {
    const cancelling = inState('CANCELLING')
    const command = validCommand(cancelling, 'restoreConfirmation')

    expect(rule(cancelling, { ...command, reason: '  ' })).toBe('blank_field')
  })
})

describe('refund pembatalan gagal', () => {
  test('diserahkan ke manusia dengan asal CANCELLING', () => {
    const awaitingRefund = refunding()

    const review = narrow(
      step(awaitingRefund, validCommand(awaitingRefund, 'requireReview')),
      'NEEDS_REVIEW',
    )

    expect(review.review.from).toBe('CANCELLING')
    expect(review.paymentId).toBe(awaitingRefund.paymentId)
  })
})
