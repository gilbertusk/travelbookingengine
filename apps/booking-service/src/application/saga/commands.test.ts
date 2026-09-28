import { COMMAND_PAYLOADS } from '@tbe/event-contracts'
import { describe, expect, test } from 'vitest'
import { inState, narrow, PAYMENT_ID } from '../../testing/builders.js'
import {
  refundPayment,
  refundRequestIdFor,
  supplierCancel,
  supplierConfirm,
  voucherGenerate,
} from './commands.js'

/**
 * Perintah saga harus lolos kontraknya — outbox menolak yang tidak, dan
 * penolakan itu membatalkan transaksi bisnisnya — dan kunci idempotensinya
 * harus STABIL: saga dapat mengirim perintah yang sama lebih dari sekali.
 */

const BOOKING = '3f0c8a52-6d1e-4c3b-9a7f-0e1d2c3b4a59'
const OTHER_PAYMENT = 'd3e5f7a9-1b2c-4d4e-9f60-7b8c9d0e1f2a'

describe('pengenal refund', () => {
  test('sama untuk pemesanan dan pembayaran yang sama — pengiriman ulang dikenali payment-service', () => {
    expect(refundRequestIdFor(BOOKING, PAYMENT_ID)).toBe(refundRequestIdFor(BOOKING, PAYMENT_ID))
  })

  test('berbeda untuk pembayaran kedua — dua uang yang harus dikembalikan', () => {
    expect(refundRequestIdFor(BOOKING, PAYMENT_ID)).not.toBe(
      refundRequestIdFor(BOOKING, OTHER_PAYMENT),
    )
  })

  test('UUID versi 8 yang diterima kontrak', () => {
    const id = refundRequestIdFor(BOOKING, PAYMENT_ID)

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})

describe('perintah lolos kontraknya', () => {
  test('supplier.confirm dari pemesanan HELD', () => {
    const held = narrow(inState('HELD'), 'HELD')
    const command = supplierConfirm(held)

    expect(COMMAND_PAYLOADS['supplier.confirm'].safeParse(command.payload).success).toBe(true)
    expect(command.payload).toMatchObject({ holdRef: held.holdRef, idempotencyKey: held.id })
  })

  test('payment.refund', () => {
    const paid = inState('PAID')
    const command = refundPayment(
      paid,
      { paymentId: PAYMENT_ID, amount: paid.price.total },
      'supplier_failed',
    )

    expect(COMMAND_PAYLOADS['payment.refund'].safeParse(command.payload).success).toBe(true)
  })

  test('supplier.cancel dan voucher.generate', () => {
    const confirmed = inState('CONFIRMED')

    const cancel = supplierCancel(confirmed, 'SKY-BK-1')
    const voucher = voucherGenerate(confirmed.id)

    expect(COMMAND_PAYLOADS['supplier.cancel'].safeParse(cancel.payload).success).toBe(true)
    expect(COMMAND_PAYLOADS['voucher.generate'].safeParse(voucher.payload).success).toBe(true)
  })
})
