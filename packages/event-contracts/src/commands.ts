import { z } from 'zod'
import { messageSchema, moneySchema } from './envelope.js'

/**
 * Perintah RabbitMQ — pekerjaan yang harus dikerjakan.
 *
 * Perintah dinamai dalam bentuk imperatif dan ditujukan kepada satu pihak.
 * Perbedaannya dengan peristiwa bukan soal teknologi: peristiwa menyatakan
 * sesuatu telah terjadi dan boleh diabaikan siapa pun, sementara perintah
 * menuntut ada yang mengerjakannya, melaporkan hasilnya, dan mencobanya lagi
 * bila gagal. Ketiga hal itu tidak dimiliki aliran peristiwa.
 */

const supplierCode = z.enum(['SKY', 'NOVA', 'ORBIT', 'LUNA', 'ZEPH'])

export const COMMAND_TYPES = [
  'supplier.confirm',
  'supplier.cancel',
  'voucher.generate',
  'notification.send',
  'payment.refund',
  'reconciliation.run',
] as const

export type CommandType = (typeof COMMAND_TYPES)[number]

export const supplierConfirmPayload = z.object({
  bookingId: z.uuid(),
  supplier: supplierCode,
  holdRef: z.string().min(1),
  guestName: z.string().min(1),
  /**
   * Kunci yang sama dipakai pada setiap percobaan ulang. Inilah yang membuat
   * percobaan ulang setelah timeout tidak menghasilkan pemesanan kedua.
   */
  idempotencyKey: z.string().min(1),
})

export const supplierCancelPayload = z.object({
  bookingId: z.uuid(),
  supplier: supplierCode,
  supplierRef: z.string().min(1),
})

export const voucherGeneratePayload = z.object({
  bookingId: z.uuid(),
})

export const notificationSendPayload = z.object({
  bookingId: z.uuid().optional(),
  userId: z.uuid(),
  template: z.enum([
    'booking_confirmed',
    'booking_failed',
    'booking_cancelled',
    'refund_completed',
    'manual_review',
  ]),
  channel: z.enum(['email']),
})

export const paymentRefundPayload = z.object({
  /** Pengenal permintaan refund. Refund idempoten terhadap nilai ini. */
  refundRequestId: z.uuid(),
  paymentId: z.uuid(),
  bookingId: z.uuid(),
  amount: moneySchema,
  reason: z.enum(['supplier_failed', 'user_cancelled', 'manual']),
})

export const reconciliationRunPayload = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  supplier: supplierCode.optional(),
})

export const COMMAND_PAYLOADS = {
  'supplier.confirm': supplierConfirmPayload,
  'supplier.cancel': supplierCancelPayload,
  'voucher.generate': voucherGeneratePayload,
  'notification.send': notificationSendPayload,
  'payment.refund': paymentRefundPayload,
  'reconciliation.run': reconciliationRunPayload,
} as const satisfies Record<CommandType, z.ZodType>

export type CommandPayload<T extends CommandType> = z.infer<(typeof COMMAND_PAYLOADS)[T]>

export const COMMAND_SCHEMAS = Object.fromEntries(
  COMMAND_TYPES.map((type) => [type, messageSchema(type, COMMAND_PAYLOADS[type])]),
) as Record<CommandType, z.ZodType>

export function isCommandType(value: string): value is CommandType {
  return (COMMAND_TYPES as readonly string[]).includes(value)
}

/** Nama antrian untuk sebuah perintah. */
export function queueNameFor(command: CommandType): string {
  return `tbe.${command.replace('.', '.')}`
}
