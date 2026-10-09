import type { EventPublisher } from '@tbe/messaging'
import type { SupplierCode } from '@tbe/supplier-adapters'
import type { CancelReplies, ConfirmReplies, SupplierEvents } from '../application/ports.js'

/**
 * Perubahan keadaan pemutus sebagai peristiwa Kafka.
 *
 * Peristiwa, bukan perintah: tidak ada yang diminta melakukan apa pun. Yang
 * disampaikan adalah fakta — supplier ini sedang tidak sehat — dan siapa pun
 * yang peduli boleh mendengarkan. Dasbor operasi mendengarkannya pada Step 27.
 */
export function createKafkaSupplierEvents(publisher: EventPublisher): SupplierEvents {
  return {
    async degraded(supplier: SupplierCode, state: 'open' | 'half_open', reason: string) {
      await publisher.publish('supplier.degraded', { supplier, circuitState: state, reason })
    },

    async recovered(supplier: SupplierCode) {
      await publisher.publish('supplier.recovered', { supplier })
    },
  }
}

/**
 * Jawaban atas `supplier.confirm` sebagai peristiwa Kafka (Step 19).
 *
 * Diterbitkan langsung, bukan lewat outbox: supplier-service tidak punya
 * keadaan bisnis yang harus berubah bersamaan dengan jawaban ini. Yang
 * dijaga di sini adalah urutannya — jawaban diterbitkan SETELAH supplier
 * menjawab, dan kegagalan menerbitkannya membuat perintahnya dicoba ulang.
 * Percobaan ulang aman karena `book` idempoten terhadap kunci yang sama; yang
 * kedua kalinya mengadopsi pemesanan yang pertama.
 */
export function createKafkaConfirmReplies(publisher: EventPublisher): ConfirmReplies {
  return {
    async confirmed(reply) {
      await publisher.publish('supplier.booking_confirmed', reply)
    },
    async rejected(reply) {
      await publisher.publish('supplier.booking_rejected', reply)
    },
    async uncertain(reply) {
      await publisher.publish('supplier.booking_uncertain', reply)
    },
  }
}

/**
 * Jawaban atas `supplier.cancel` (Step 25). Diterbitkan setelah supplier
 * menjawab; kegagalan menerbitkannya membuat perintahnya dicoba ulang, dan
 * pembatalan yang kedua kalinya dijawab `already_cancelled` — yang diumumkan
 * sebagai `cancelled` lagi.
 */
export function createKafkaCancelReplies(publisher: EventPublisher): CancelReplies {
  return {
    async cancelled(reply) {
      await publisher.publish('supplier.booking_cancelled', reply)
    },
    async cancelFailed(reply) {
      await publisher.publish('supplier.booking_cancel_failed', reply)
    },
  }
}
