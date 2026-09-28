import { COMMAND_PAYLOADS, EVENT_PAYLOADS, isCommandType, isEventType } from '@tbe/event-contracts'
import type { CommandSender, EnvelopeOptions, EventPublisher } from '@tbe/messaging'
import { ValidationError } from '@tbe/shared-kernel'
import type { OutboxMessage, OutboxTransport } from './outbox-relay.js'

/**
 * Pesan outbox ke broker yang benar: peristiwa ke Kafka, perintah ke RabbitMQ.
 *
 * Saluran dicatat saat pesan ditulis, dan di sini DIPERIKSA ulang terhadap
 * jenisnya — peristiwa yang tercatat sebagai perintah adalah pesan yang rusak,
 * dan ditolak alih-alih dikirim lewat broker yang salah. Pemisahan peran dua
 * broker (@tbe/messaging) tidak boleh bocor lewat pintu belakang outbox.
 *
 * Payload diurai ulang dengan skema kontraknya: kolom JSON tidak dijamin tipe
 * apa pun.
 */
export function createMessagingTransport(
  publisher: EventPublisher,
  sender: CommandSender,
): OutboxTransport {
  return {
    async send(message) {
      const envelope = envelopeOf(message)

      if (message.channel === 'kafka' && isEventType(message.messageType)) {
        const parsed = EVENT_PAYLOADS[message.messageType].safeParse(message.payload)
        if (!parsed.success) throw rejected(message)
        await publisher.publish(message.messageType, parsed.data, envelope)
        return
      }

      if (message.channel === 'rabbitmq' && isCommandType(message.messageType)) {
        const parsed = COMMAND_PAYLOADS[message.messageType].safeParse(message.payload)
        if (!parsed.success) throw rejected(message)
        await sender.send(message.messageType, parsed.data, envelope)
        return
      }

      throw new ValidationError(
        `Pesan outbox ${message.messageType} tidak sesuai salurannya (${message.channel})`,
      )
    },
  }
}

function envelopeOf(message: OutboxMessage): EnvelopeOptions {
  return {
    eventId: message.id,
    occurredAt: message.occurredAt.toISOString(),
    correlationId: message.correlationId,
    ...(message.causationId === undefined ? {} : { causationId: message.causationId }),
    ...(message.traceparent === undefined ? {} : { traceparent: message.traceparent }),
  }
}

function rejected(message: OutboxMessage): ValidationError {
  return new ValidationError(`Payload outbox ${message.messageType} tidak sesuai kontrak`)
}
