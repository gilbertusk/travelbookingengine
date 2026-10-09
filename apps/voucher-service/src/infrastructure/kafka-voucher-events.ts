import type { EventPublisher } from '@tbe/messaging'
import type { VoucherEvents } from '../application/ports.js'

/**
 * `voucher.issued` sebagai peristiwa Kafka, berkunci partisi bookingId.
 *
 * eventId adalah id voucher dan occurredAt adalah waktu terbitnya — bukan
 * nilai baru setiap kali diterbitkan. Penerbitan ulang untuk voucher yang sama
 * (lihat issue-voucher.ts) menghasilkan pesan yang identik, dan pembacanya
 * menyaring duplikat lewat eventId.
 */
export function createKafkaVoucherEvents(publisher: EventPublisher): VoucherEvents {
  return {
    async issued(voucher, latencyMs) {
      await publisher.publish(
        'voucher.issued',
        {
          bookingId: voucher.bookingId,
          voucherId: voucher.id,
          userId: voucher.userId,
          issuedAt: voucher.issuedAt.toISOString(),
          latencyMs,
        },
        { eventId: voucher.id, occurredAt: voucher.issuedAt.toISOString() },
      )
    },
  }
}
