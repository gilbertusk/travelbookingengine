import {
  COMMAND_SCHEMAS,
  createMessage,
  type CommandPayload,
  type CommandType,
} from '@tbe/event-contracts'
import { ValidationError } from '@tbe/shared-kernel'
import type { PublishOptions, RabbitPublisher } from '../ports.js'
import { RETRY_COUNT_HEADER } from '../retry.js'
import { COMMAND_EXCHANGE } from './topology.js'
import { traceparentField } from '../trace.js'
import { envelopeOverrides, type EnvelopeOptions } from '../envelope-options.js'

/**
 * Pengirim perintah.
 *
 * Hanya menerima jenis perintah — tidak ada cara mengirim peristiwa lewat
 * sini. Pemisahan itu ditegakkan oleh tipe, bukan oleh kesepakatan, karena
 * kesepakatan akan dilanggar pada suatu sore yang sibuk.
 */

/** Lihat envelope-options.ts: amplop dapat ditetapkan lebih dulu oleh outbox. */
export type SendOptions = EnvelopeOptions

export interface CommandSender {
  send<T extends CommandType>(
    type: T,
    payload: CommandPayload<T>,
    options?: SendOptions,
  ): Promise<void>
}

export function createCommandSender(publisher: RabbitPublisher): CommandSender {
  return {
    async send(type, payload, options) {
      const message = createMessage({
        eventType: type,
        payload,
        ...envelopeOverrides(options),
        ...traceparentField(options?.traceparent),
      })

      // Divalidasi sebelum dikirim, bukan hanya saat diterima. Perintah cacat
      // yang sudah terlanjur masuk antrian hanya bisa berakhir di dead letter,
      // dan pada titik itu pemanggilnya sudah lama pergi.
      const parsed = COMMAND_SCHEMAS[type].safeParse(message)
      if (!parsed.success) {
        throw new ValidationError(`Perintah "${type}" tidak sesuai kontrak`, {
          issues: parsed.error.issues.map((issue) => ({
            field: issue.path.join('.'),
            message: issue.message,
          })),
        })
      }

      await publisher.publish(
        COMMAND_EXCHANGE,
        type,
        Buffer.from(JSON.stringify(message), 'utf8'),
        publishOptions(message.eventId, message.correlationId, 0),
      )
    },
  }
}

export function publishOptions(
  messageId: string,
  correlationId: string,
  retryCount: number,
): PublishOptions {
  return {
    headers: { [RETRY_COUNT_HEADER]: retryCount },
    messageId,
    correlationId,
    persistent: true,
  }
}
