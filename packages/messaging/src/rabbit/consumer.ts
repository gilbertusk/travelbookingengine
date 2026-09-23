import {
  COMMAND_SCHEMAS,
  type CommandPayload,
  type CommandType,
  type Message,
} from '@tbe/event-contracts'
import { ValidationError, runWithCorrelation, type Logger } from '@tbe/shared-kernel'
import type { CommandOutcome, IncomingCommand, RabbitPublisher } from '../ports.js'
import { dispositionFor, headerString, type Disposition } from '../retry.js'
import { publishOptions } from './sender.js'
import { DEAD_LETTER_EXCHANGE, RETRY_EXCHANGE, retryRoutingKey } from './topology.js'

/**
 * Pembungkus consumer perintah.
 *
 * Tiga hal terjadi di sini dan tidak boleh terjadi di tempat lain: pesan
 * divalidasi terhadap kontraknya, correlationId dipulihkan ke konteks yang
 * sedang berjalan, dan kegagalan diarahkan ke antrian tunda atau dead letter
 * sesuai jenisnya. Handler bisnis hanya menerima payload yang sudah terjamin
 * bentuknya.
 */

export interface CommandHandlerOptions<T extends CommandType> {
  readonly command: T
  readonly publisher: RabbitPublisher
  readonly logger: Logger
  handle(payload: CommandPayload<T>, message: Message<T, CommandPayload<T>>): Promise<void>
}

export type CommandConsumer = (incoming: IncomingCommand) => Promise<CommandOutcome>

export function createCommandConsumer<T extends CommandType>(
  options: CommandHandlerOptions<T>,
): CommandConsumer {
  const { command, publisher, logger } = options

  return async (incoming) => {
    const parsed = parseCommand(command, incoming)

    if (parsed === undefined) {
      // Pesan yang tidak dapat diurai atau tidak sesuai kontrak tidak akan
      // pernah menjadi benar dengan menunggu. Langsung ke dead letter.
      logger.error({ command }, 'perintah tidak sesuai kontrak, dikirim ke dead letter')
      return await route(publisher, command, incoming, {
        kind: 'dead_letter',
        reason: 'not_retryable',
      })
    }

    try {
      await runWithCorrelation(parsed.correlationId, async () => {
        await options.handle(parsed.payload, parsed)
      })
      return 'ack'
    } catch (error) {
      const disposition = dispositionFor(error, incoming.headers)
      logCommandFailure(logger, command, error, disposition)
      return await route(publisher, command, incoming, disposition)
    }
  }
}

function parseCommand<T extends CommandType>(
  command: T,
  incoming: IncomingCommand,
): Message<T, CommandPayload<T>> | undefined {
  try {
    const raw: unknown = JSON.parse(incoming.content.toString('utf8'))
    const parsed = COMMAND_SCHEMAS[command].safeParse(raw)

    return parsed.success ? (parsed.data as Message<T, CommandPayload<T>>) : undefined
  } catch {
    // JSON yang rusak adalah bentuk lain dari pesan cacat, bukan kegagalan
    // sistem. Ditangani sebagai jawaban, bukan dilempar ulang.
    return undefined
  }
}

function logCommandFailure(
  logger: Logger,
  command: CommandType,
  error: unknown,
  disposition: Disposition,
): void {
  if (disposition.kind === 'retry') {
    logger.warn(
      { err: error, command, attempt: disposition.attempt, delayMs: disposition.tier.delayMs },
      'perintah gagal, dijadwalkan dicoba ulang',
    )
    return
  }

  // Perintah yang berakhir di dead letter berarti ada pekerjaan yang tidak
  // pernah selesai. Untuk refund, itu berarti uang pengguna tertahan — jadi
  // tingkatnya error, bukan warn.
  logger.error(
    { err: error, command, reason: disposition.reason },
    'perintah masuk dead letter dan butuh penanganan manusia',
  )
}

async function route(
  publisher: RabbitPublisher,
  command: CommandType,
  incoming: IncomingCommand,
  disposition: Disposition,
): Promise<CommandOutcome> {
  const messageId = headerString(incoming.headers['x-message-id'])
  const correlationId = headerString(incoming.headers['x-correlation-id'])

  try {
    if (disposition.kind === 'retry') {
      await publisher.publish(
        RETRY_EXCHANGE,
        retryRoutingKey(command, disposition.tier.name),
        incoming.content,
        publishOptions(messageId, correlationId, disposition.attempt),
      )
    } else {
      await publisher.publish(
        DEAD_LETTER_EXCHANGE,
        command,
        incoming.content,
        publishOptions(messageId, correlationId, 0),
      )
    }

    return 'ack'
  } catch {
    // Kalau penerbitan ulang gagal, pesan aslinya belum boleh di-ack —
    // mengembalikannya ke antrian adalah satu-satunya cara agar tidak hilang.
    return 'requeue'
  }
}

export function isValidationFailure(error: unknown): boolean {
  return error instanceof ValidationError
}
