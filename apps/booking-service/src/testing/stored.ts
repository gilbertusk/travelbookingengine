import type { Booking } from '../domain/booking.js'
import type { CommandType } from '../domain/commands.js'
import { applyCommand } from '../domain/transitions.js'
import { draftChange, sampleKey, validCommand } from './builders.js'
import type { Harness } from './fakes.js'

/**
 * Menyimpan pemesanan baru lewat repository lalu menjalankan perintah-
 * perintahnya satu per satu, masing-masing satu menit setelah perubahan
 * sebelumnya (lihat validCommand). Setiap langkah tersimpan beserta
 * peristiwanya — termasuk BookingHeld dengan harga bersih supplier, yang
 * dibaca rekonsiliasi.
 */
export async function storedBooking(
  world: Harness,
  suffix: string,
  ...path: CommandType[]
): Promise<Booking> {
  const change = draftChange({ id: bookingIdFor(suffix), key: sampleKey(suffix) })
  await world.deps.bookings.create(change)

  let booking: Booking = change.booking
  for (const type of path) {
    const applied = applyCommand(booking, validCommand(booking, type))
    if (!applied.ok) throw applied.error
    await world.deps.bookings.save(applied.value)
    booking = applied.value.booking
  }
  return booking
}

export function bookingIdFor(suffix: string): string {
  return `3f0c8a52-6d1e-4c3b-9a7f-${suffix.padStart(12, '0')}`
}

export const TO_CONFIRMED: readonly CommandType[] = [
  'verifyPrice',
  'hold',
  'recordPayment',
  'confirm',
]
export const TO_REFUNDED: readonly CommandType[] = [
  'verifyPrice',
  'hold',
  'recordPayment',
  'fail',
  'recordRefund',
]
export const TO_PAID_CANCELLED: readonly CommandType[] = [
  ...TO_CONFIRMED,
  'requestCancellation',
  'confirmSupplierCancellation',
  'completeCancellation',
]
