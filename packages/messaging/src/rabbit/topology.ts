import { COMMAND_TYPES, type CommandType } from '@tbe/event-contracts'
import { RETRY_TIERS } from '../retry.js'

/**
 * Topologi RabbitMQ sebagai data, bukan sebagai rangkaian panggilan.
 *
 * Dideklarasikan sebagai nilai supaya dapat diperiksa pengujian tanpa broker
 * yang berjalan. Topologi yang hanya ada sebagai efek samping pemanggilan
 * assertQueue tersebar di banyak berkas hanya dapat diperiksa dengan membuka
 * antarmuka RabbitMQ dan melihatnya dengan mata.
 */

export const COMMAND_EXCHANGE = 'tbe.commands'
export const RETRY_EXCHANGE = 'tbe.retry'
export const DEAD_LETTER_EXCHANGE = 'tbe.dead-letter'

export interface ExchangeDeclaration {
  readonly name: string
  readonly type: 'direct'
  readonly durable: true
}

export interface QueueDeclaration {
  readonly name: string
  readonly durable: true
  readonly arguments?: Readonly<Record<string, string | number>>
}

export interface BindingDeclaration {
  readonly queue: string
  readonly exchange: string
  readonly routingKey: string
}

export interface Topology {
  readonly exchanges: readonly ExchangeDeclaration[]
  readonly queues: readonly QueueDeclaration[]
  readonly bindings: readonly BindingDeclaration[]
}

export function mainQueue(command: CommandType): string {
  return `tbe.${command}`
}

export function retryQueue(command: CommandType, tier: string): string {
  return `tbe.${command}.retry.${tier}`
}

export function deadLetterQueue(command: CommandType): string {
  return `tbe.${command}.dlq`
}

export function retryRoutingKey(command: CommandType, tier: string): string {
  return `${command}.${tier}`
}

export function topologyFor(commands: readonly CommandType[] = COMMAND_TYPES): Topology {
  const queues: QueueDeclaration[] = []
  const bindings: BindingDeclaration[] = []

  for (const command of commands) {
    queues.push({ name: mainQueue(command), durable: true })
    bindings.push({ queue: mainQueue(command), exchange: COMMAND_EXCHANGE, routingKey: command })

    for (const tier of RETRY_TIERS) {
      queues.push({
        name: retryQueue(command, tier.name),
        durable: true,
        arguments: {
          // Pesan menunggu di sini sampai TTL habis, lalu RabbitMQ sendiri yang
          // mengembalikannya ke antrian utama. Tidak ada penjadwal yang perlu
          // ditulis, dan tidak ada timer yang hilang saat proses restart.
          'x-message-ttl': tier.delayMs,
          'x-dead-letter-exchange': COMMAND_EXCHANGE,
          'x-dead-letter-routing-key': command,
        },
      })
      bindings.push({
        queue: retryQueue(command, tier.name),
        exchange: RETRY_EXCHANGE,
        routingKey: retryRoutingKey(command, tier.name),
      })
    }

    queues.push({ name: deadLetterQueue(command), durable: true })
    bindings.push({
      queue: deadLetterQueue(command),
      exchange: DEAD_LETTER_EXCHANGE,
      routingKey: command,
    })
  }

  return {
    exchanges: [
      { name: COMMAND_EXCHANGE, type: 'direct', durable: true },
      { name: RETRY_EXCHANGE, type: 'direct', durable: true },
      { name: DEAD_LETTER_EXCHANGE, type: 'direct', durable: true },
    ],
    queues,
    bindings,
  }
}
