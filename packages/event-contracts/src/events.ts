import { z } from 'zod'
import { messageSchema, moneySchema } from './envelope.js'

/**
 * Peristiwa Kafka — fakta yang sudah terjadi.
 *
 * Peristiwa dinamai dalam bentuk lampau dan tidak pernah memerintahkan apa pun.
 * Pembedaan ini bukan gaya penamaan: peristiwa boleh dibaca banyak konsumen
 * yang tidak saling tahu, sementara perintah harus dikerjakan tepat satu pihak.
 * Perintah tinggal di commands.ts dan berjalan lewat RabbitMQ.
 */

const supplierCode = z.enum(['SKY', 'NOVA', 'ORBIT', 'LUNA', 'ZEPH'])
const stayDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'harus tanggal lokal YYYY-MM-DD')

export const EVENT_TYPES = [
  'search.performed',
  'booking.created',
  'booking.held',
  'booking.price_changed',
  'booking.confirmed',
  'booking.failed',
  'booking.cancelled',
  'payment.succeeded',
  'payment.failed',
  'payment.refunded',
  'supplier.degraded',
  'supplier.recovered',
] as const

export type EventType = (typeof EVENT_TYPES)[number]

/**
 * Pencarian tidak memuat data pribadi apa pun — tidak ada userId, tidak ada
 * alamat surel. Topik ini beretensi pendek dan dibaca analitik, dan tidak ada
 * alasan data pribadi ikut ke sana.
 */
export const searchPerformedPayload = z.object({
  city: z.string(),
  checkIn: stayDate,
  checkOut: stayDate,
  guests: z.number().int().positive(),
  resultCount: z.number().int().nonnegative(),
  latencyMs: z.number().int().nonnegative(),
  source: z.enum(['cache', 'live', 'partial_cache']),
  suppliersResponded: z.array(supplierCode),
  suppliersTimedOut: z.array(supplierCode),
  suppliersUnavailable: z.array(supplierCode),
})

export const bookingCreatedPayload = z.object({
  bookingId: z.uuid(),
  userId: z.uuid(),
  supplier: supplierCode,
  propertyId: z.string(),
  ratePlanRef: z.string(),
  checkIn: stayDate,
  checkOut: stayDate,
  guests: z.number().int().positive(),
  amount: moneySchema,
})

export const bookingHeldPayload = z.object({
  bookingId: z.uuid(),
  holdRef: z.string(),
  expiresAt: z.iso.datetime(),
})

export const bookingPriceChangedPayload = z.object({
  bookingId: z.uuid(),
  previousAmount: moneySchema,
  newAmount: moneySchema,
})

export const bookingConfirmedPayload = z.object({
  bookingId: z.uuid(),
  supplier: supplierCode,
  /** Bukti pemesanan yang sah. Pengenal internal bukan bukti apa pun. */
  supplierRef: z.string().min(1),
})

export const bookingFailedPayload = z.object({
  bookingId: z.uuid(),
  /** Langkah saga tempat kegagalan terjadi. Menentukan kompensasi apa yang perlu. */
  stage: z.enum(['price_check', 'hold', 'payment', 'supplier_confirm', 'voucher']),
  reason: z.string(),
  /** true bila status di supplier tidak dapat dipastikan — lihat US-05. */
  requiresManualReview: z.boolean(),
})

export const bookingCancelledPayload = z.object({
  bookingId: z.uuid(),
  reason: z.enum(['user_request', 'hold_expired', 'payment_failed', 'supplier_rejected']),
  refundAmount: moneySchema.optional(),
})

export const paymentSucceededPayload = z.object({
  paymentId: z.uuid(),
  bookingId: z.uuid(),
  amount: moneySchema,
  gatewayRef: z.string(),
})

export const paymentFailedPayload = z.object({
  paymentId: z.uuid(),
  bookingId: z.uuid(),
  reason: z.string(),
})

export const paymentRefundedPayload = z.object({
  refundId: z.uuid(),
  paymentId: z.uuid(),
  bookingId: z.uuid(),
  amount: moneySchema,
})

export const supplierDegradedPayload = z.object({
  supplier: supplierCode,
  circuitState: z.enum(['open', 'half_open']),
  reason: z.string(),
})

export const supplierRecoveredPayload = z.object({
  supplier: supplierCode,
})

export const EVENT_PAYLOADS = {
  'search.performed': searchPerformedPayload,
  'booking.created': bookingCreatedPayload,
  'booking.held': bookingHeldPayload,
  'booking.price_changed': bookingPriceChangedPayload,
  'booking.confirmed': bookingConfirmedPayload,
  'booking.failed': bookingFailedPayload,
  'booking.cancelled': bookingCancelledPayload,
  'payment.succeeded': paymentSucceededPayload,
  'payment.failed': paymentFailedPayload,
  'payment.refunded': paymentRefundedPayload,
  'supplier.degraded': supplierDegradedPayload,
  'supplier.recovered': supplierRecoveredPayload,
} as const satisfies Record<EventType, z.ZodType>

export type EventPayload<T extends EventType> = z.infer<(typeof EVENT_PAYLOADS)[T]>

export const EVENT_SCHEMAS = Object.fromEntries(
  EVENT_TYPES.map((type) => [type, messageSchema(type, EVENT_PAYLOADS[type])]),
) as Record<EventType, z.ZodType>

export function isEventType(value: string): value is EventType {
  return (EVENT_TYPES as readonly string[]).includes(value)
}
