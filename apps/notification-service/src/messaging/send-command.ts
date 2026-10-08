import type { CommandPayload, Message } from '@tbe/event-contracts'
import { AppError } from '@tbe/shared-kernel'
import type { NotificationDeps } from '../application/ports.js'
import { fromCommand } from '../domain/policy.js'

/**
 * Consumer perintah RabbitMQ `notification.send`: jalur PERMINTAAN.
 *
 * Berbeda dari jalur Kafka, tidak ada keputusan di sini. Service lain —
 * operator yang mengirim ulang konfirmasi, rekonsiliasi (Step 28) — sudah
 * memutuskan surel apa yang harus dikirim, dan menuntut ada yang
 * mengerjakannya. Itulah sifat perintah: satu penerima, wajib dikerjakan,
 * dicoba ulang bila gagal (ADR-0003).
 *
 * Seperti jalur Kafka, handler hanya mencatat; penghantar yang mengirim.
 * Jenjang tunda RabbitMQ hanya menampung kegagalan MENCATAT — basis data
 * yang mati. Kegagalan MENGIRIM ditangani penghantar dengan jenjangnya sendiri.
 */

/** Pemberitahuan tanpa pemesanan belum punya template; menunggu tidak akan mengubahnya. */
export class NotificationWithoutBookingError extends AppError {
  constructor(template: string) {
    super({
      code: 'NOTIFICATION_WITHOUT_BOOKING',
      httpStatus: 422,
      message: `Template ${template} membutuhkan pemesanan, tetapi perintah tidak menyebut bookingId`,
    })
  }
}

export function handleSendCommand(deps: NotificationDeps, wake: () => void) {
  return async (
    payload: CommandPayload<'notification.send'>,
    message: Message<'notification.send', CommandPayload<'notification.send'>>,
  ): Promise<void> => {
    if (payload.bookingId === undefined) throw new NotificationWithoutBookingError(payload.template)

    const request = fromCommand({
      commandId: message.eventId,
      correlationId: message.correlationId,
      bookingId: payload.bookingId,
      userId: payload.userId,
      template: payload.template,
    })
    const outcome = await deps.notifications.request(request, deps.clock.now())
    wake()
    deps.logger.info(
      {
        commandId: message.eventId,
        bookingId: payload.bookingId,
        type: payload.template,
        outcome: outcome.kind,
      },
      'pemberitahuan dicatat dari perintah',
    )
  }
}
