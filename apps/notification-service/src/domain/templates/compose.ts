import { map, type Result } from '@tbe/shared-kernel'
import type { BookingSnapshot } from '../booking-snapshot.js'
import type { NotificationContext } from '../notification.js'
import {
  cancelledMessage,
  confirmedMessage,
  failedMessage,
  refundedMessage,
  reviewMessage,
  type ComposeRefusal,
} from './copy.js'
import { render, type Message } from './layout.js'

export { REFUND_ARRIVAL, REVIEW_CONTACT_WITHIN, type ComposeRefusal } from './copy.js'

/** Surel yang siap dikirim, tanpa lampiran — lampiran urusan penghantar. */
export interface EmailContent {
  readonly subject: string
  readonly text: string
  readonly html: string
}

/**
 * Menyusun surel dari jenis pemberitahuan dan keadaan pemesanan saat ini.
 *
 * Penolakan dikembalikan sebagai nilai (CONVENTIONS.md bagian 5): surel yang
 * tidak lagi benar bukan galat sistem, dan tidak ada gunanya dicoba ulang.
 */
export function compose(
  context: NotificationContext,
  booking: BookingSnapshot,
): Result<EmailContent, ComposeRefusal> {
  return map(messageFor(context, booking), (message) => ({
    subject: message.subject,
    ...render(message, { name: booking.leadGuest.fullName, bookingId: booking.bookingId }),
  }))
}

function messageFor(
  context: NotificationContext,
  booking: BookingSnapshot,
): Result<Message, ComposeRefusal> {
  switch (context.type) {
    case 'booking_confirmed':
      return confirmedMessage(booking)
    case 'booking_failed':
      return failedMessage(booking)
    case 'manual_review':
      return reviewMessage(booking, context.concern)
    case 'booking_cancelled':
      return cancelledMessage(booking, context.reason, context.refund)
    case 'refund_completed':
      return refundedMessage(booking, context.amount)
  }
}
