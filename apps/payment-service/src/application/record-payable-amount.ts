import type { Money } from '@tbe/money'
import type { PaymentDeps } from './ports.js'

/**
 * Mencatat nilai yang boleh ditagih untuk sebuah pemesanan.
 *
 * Inilah satu-satunya jalan nilai tagihan masuk ke service ini, dan jalan itu
 * adalah peristiwa Kafka — bukan permintaan HTTP dari pihak yang meminta
 * pembayaran, dan bukan panggilan langsung ke booking-service.
 *
 * `booking.price_changed` menang atas `booking.created` bukan karena jenisnya,
 * melainkan karena WAKTUNYA: harga yang disetujui pengguna adalah yang terakhir
 * ia setujui. Kalau harga berubah dua kali, peristiwa kedua yang berlaku, dan
 * membandingkan jenis peristiwa tidak dapat memutuskan itu.
 */

export interface PayableObservation {
  readonly bookingId: string
  readonly amount: Money
  readonly source: 'booking.created' | 'booking.price_changed'
  /** `occurredAt` dari amplop peristiwa, bukan waktu pemrosesan. */
  readonly occurredAt: Date
}

export async function recordPayableAmount(
  deps: PaymentDeps,
  observation: PayableObservation,
): Promise<void> {
  await deps.payables.record({
    bookingId: observation.bookingId,
    amount: observation.amount,
    source: observation.source,
    observedAt: observation.occurredAt,
  })

  deps.logger.debug(
    {
      bookingId: observation.bookingId,
      source: observation.source,
      amountMinor: observation.amount.amountMinor,
      currency: observation.amount.currency,
    },
    'nilai yang boleh ditagih diperbarui dari peristiwa pemesanan',
  )
}
