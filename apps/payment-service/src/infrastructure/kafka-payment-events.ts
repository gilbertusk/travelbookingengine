import type { EventPublisher } from '@tbe/messaging'
import type { PaymentEvents } from '../application/ports.js'

/**
 * Peristiwa pembayaran sebagai peristiwa Kafka.
 *
 * Peristiwa, bukan perintah: tidak ada yang diminta melakukan apa pun. Yang
 * disampaikan adalah fakta — pembayaran ini berhasil — dan siapa pun yang peduli
 * boleh mendengarkan. Saga pemesanan mendengarkannya pada Step 19, pemberitahuan
 * pada Step 24, analitik pada Step 27, dan tidak satu pun dari ketiganya perlu
 * diketahui service ini.
 *
 * Ketiganya berkunci partisi `bookingId` — lihat TOPICS di
 * packages/event-contracts. Itu yang menjamin `payment.succeeded` dan
 * `payment.refunded` untuk satu pemesanan tiba berurutan pada consumer yang
 * sama; tanpa kunci itu, refund bisa terbaca sebelum pembayarannya.
 */
export function createKafkaPaymentEvents(publisher: EventPublisher): PaymentEvents {
  return {
    async succeeded(input) {
      await publisher.publish('payment.succeeded', {
        paymentId: input.paymentId,
        bookingId: input.bookingId,
        amount: { amountMinor: input.amount.amountMinor, currency: input.amount.currency },
        gatewayRef: input.gatewayRef,
      })
    },

    async failed(input) {
      await publisher.publish('payment.failed', {
        paymentId: input.paymentId,
        bookingId: input.bookingId,
        reason: input.reason,
      })
    },

    async refunded(input) {
      await publisher.publish('payment.refunded', {
        refundId: input.refundId,
        paymentId: input.paymentId,
        bookingId: input.bookingId,
        amount: { amountMinor: input.amount.amountMinor, currency: input.amount.currency },
      })
    },

    async refundFailed(input) {
      await publisher.publish('payment.refund_failed', {
        refundRequestId: input.refundRequestId,
        paymentId: input.paymentId,
        bookingId: input.bookingId,
        amount: { amountMinor: input.amount.amountMinor, currency: input.amount.currency },
        reason: input.reason,
      })
    },
  }
}
