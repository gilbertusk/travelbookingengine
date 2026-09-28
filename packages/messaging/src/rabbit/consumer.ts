import {
  COMMAND_SCHEMAS,
  type CommandPayload,
  type CommandType,
  type Message,
} from '@tbe/event-contracts'
import {
  ValidationError,
  runWithCorrelation,
  withTraceparent,
  type Logger,
} from '@tbe/shared-kernel'
import type { CommandOutcome, IncomingCommand, RabbitPublisher } from '../ports.js'
import {
  LAST_RETRY_TIER,
  attemptsSoFar,
  dispositionFor,
  headerString,
  type Disposition,
} from '../retry.js'
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
  /**
   * Dipanggil SEBELUM perintah yang bentuknya sah dipindahkan ke dead letter —
   * percobaannya habis, atau kegagalannya final.
   *
   * Ditambahkan Step 19. Dead letter adalah akhir yang diam: pesan tertahan,
   * galat tercatat, dan tidak ada yang memberi tahu pihak yang MENGIRIM
   * perintah. Untuk `supplier.confirm`, pihak itu saga yang menunggu
   * jawabannya; tanpa kabar ini ia menunggu sampai batas waktunya sendiri.
   *
   * Kegagalan di sini TIDAK membuang pesan dan tidak memutarnya seketika:
   * pesan kembali ke jenjang tunda TERAKHIR dengan hitungan percobaan yang
   * sama, lalu kembali lagi ke sini setelah tundaannya. Mengembalikannya ke
   * antrian utama (`requeue`) akan memutarnya tanpa jeda selama Kafka mati.
   */
  readonly onDeadLetter?: (context: DeadLetterContext<T>) => Promise<void>
}

export interface DeadLetterContext<T extends CommandType> {
  readonly payload: CommandPayload<T>
  readonly message: Message<T, CommandPayload<T>>
  /** Galat terakhir dari handler — yang menentukan apa yang dikabarkan. */
  readonly error: unknown
  readonly reason: 'exhausted' | 'not_retryable'
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
      await withTraceparent(parsed.traceparent, async () => {
        await runWithCorrelation(parsed.correlationId, async () => {
          await options.handle(parsed.payload, parsed)
        })
      })
      return 'ack'
    } catch (error) {
      const disposition = dispositionFor(error, incoming.headers)
      logCommandFailure(logger, command, error, disposition)
      const final = await announceDeadLetter(options, parsed, { error, disposition, incoming })
      return await route(publisher, command, incoming, final)
    }
  }
}

interface Failure {
  readonly error: unknown
  readonly disposition: Disposition
  readonly incoming: IncomingCommand
}

/**
 * Menjalankan kabar dead letter, dan memutuskan ulang ke mana pesannya pergi
 * bila kabar itu gagal disampaikan.
 */
async function announceDeadLetter<T extends CommandType>(
  options: CommandHandlerOptions<T>,
  parsed: Message<T, CommandPayload<T>>,
  failure: Failure,
): Promise<Disposition> {
  const { disposition } = failure
  if (disposition.kind !== 'dead_letter' || options.onDeadLetter === undefined) return disposition

  const hook = options.onDeadLetter
  try {
    await withTraceparent(parsed.traceparent, async () => {
      await runWithCorrelation(parsed.correlationId, async () => {
        await hook({
          payload: parsed.payload,
          message: parsed,
          error: failure.error,
          reason: disposition.reason,
        })
      })
    })
    return disposition
  } catch (hookError) {
    options.logger.error(
      { err: hookError, command: options.command },
      'kabar dead letter gagal disampaikan, perintah ditunda untuk dicoba lagi',
    )
    return lastTierAgain(failure.incoming)
  }
}

/**
 * Jenjang tunda terakhir, dengan hitungan percobaan yang TIDAK naik. Pesan akan
 * kembali setelah tundaannya, gagal dengan cara yang sama, dan tiba lagi di
 * dead letter — kali ini dengan kesempatan baru untuk menyampaikan kabarnya.
 */
function lastTierAgain(incoming: IncomingCommand): Disposition {
  return { kind: 'retry', tier: LAST_RETRY_TIER, attempt: attemptsSoFar(incoming.headers) }
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
