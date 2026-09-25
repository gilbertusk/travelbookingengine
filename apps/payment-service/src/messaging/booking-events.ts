import type { EventPayload, EventType, Message } from '@tbe/event-contracts'
import { money } from '@tbe/money'
import { recordPayableAmount } from '../application/record-payable-amount.js'
import type { PaymentDeps } from '../application/ports.js'

/**
 * Consumer peristiwa pemesanan.
 *
 * Service ini mendengarkan `booking.created` dan `booking.price_changed` untuk
 * satu tujuan saja: mengetahui berapa yang boleh ditagih. Ia TIDAK memanggil
 * booking-service untuk menanyakannya — Step 18 mewajibkan komunikasi lewat
 * peristiwa, dan panggilan langsung akan membuat pembayaran ikut gagal setiap
 * kali booking-service sedang tidak dapat dihubungi.
 *
 * Peristiwa lain pada topik yang sama dilewati tanpa suara oleh pembungkus
 * consumer @tbe/messaging. Itu bukan kesalahan: satu topik membawa seluruh
 * peristiwa pemesanan, dan yang tidak diminta memang bukan urusan kita.
 */

const SUBSCRIBED = ['booking.created', 'booking.price_changed'] as const

export const BOOKING_EVENTS: readonly EventType[] = SUBSCRIBED

export function handleBookingEvent(deps: PaymentDeps) {
  return async (message: Message<EventType, EventPayload<EventType>>): Promise<void> => {
    const observation = observationOf(message)

    if (observation === undefined) return

    await recordPayableAmount(deps, observation)
  }
}

type Observation = Parameters<typeof recordPayableAmount>[1]

/**
 * Membaca nilai dari payload peristiwa.
 *
 * Payload sudah divalidasi terhadap kontraknya oleh pembungkus consumer, jadi
 * yang tersisa di sini hanya pemilihan bidang — dan bidangnya berbeda antar
 * peristiwa: `booking.created` membawa `amount`, sementara
 * `booking.price_changed` membawa `previousAmount` dan `newAmount`. Yang dipakai
 * adalah `newAmount`; memakai `previousAmount` akan menagih harga yang persis
 * ditinggalkan pengguna.
 *
 * Penyempitan memakai operator `in`, bukan type assertion. `Message` bergeneral
 * atas jenis DAN payload secara terpisah, jadi menyempitkan `eventType` saja
 * tidak menyempitkan payload-nya — dan `as` di tempat seperti ini akan tetap
 * dikompilasi setelah bentuk kontraknya berubah, lalu gagal saat berjalan.
 */
function observationOf(
  message: Message<EventType, EventPayload<EventType>>,
): Observation | undefined {
  const occurredAt = new Date(message.occurredAt)
  const payload = message.payload

  if (message.eventType === 'booking.price_changed' && 'newAmount' in payload) {
    return {
      bookingId: payload.bookingId,
      amount: money(payload.newAmount.amountMinor, payload.newAmount.currency),
      source: 'booking.price_changed',
      occurredAt,
    }
  }

  if (message.eventType === 'booking.created' && 'amount' in payload) {
    return {
      bookingId: payload.bookingId,
      amount: money(payload.amount.amountMinor, payload.amount.currency),
      source: 'booking.created',
      occurredAt,
    }
  }

  return undefined
}
