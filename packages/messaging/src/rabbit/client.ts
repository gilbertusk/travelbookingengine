import type { ManagedResource } from '@tbe/shared-kernel'
import amqp, { type AmqpConnectionManager, type ChannelWrapper } from 'amqp-connection-manager'
import type { ConfirmChannel } from 'amqplib'
import type { CommandOutcome, IncomingCommand, RabbitPublisher } from '../ports.js'
import { topologyFor, type Topology } from './topology.js'

/**
 * Adapter tipis ke amqplib, lewat amqp-connection-manager.
 *
 * Pembungkus koneksi dipakai karena amqplib polos tidak menyambung ulang:
 * satu kali koneksi putus, consumer berhenti diam-diam dan tidak ada yang
 * memberitahu. Topologi dideklarasikan di dalam setup, sehingga ikut dibuat
 * ulang setiap kali koneksi pulih.
 */

export interface RabbitConnectionOptions {
  readonly url: string
  readonly topology?: Topology
}

export interface RabbitConnection {
  readonly publisher: RabbitPublisher
  readonly resource: ManagedResource
  consume(queue: string, prefetch: number, handler: RabbitHandler): void
}

export type RabbitHandler = (incoming: IncomingCommand) => Promise<CommandOutcome>

export function createRabbitConnection(options: RabbitConnectionOptions): RabbitConnection {
  const topology = options.topology ?? topologyFor()
  const connection: AmqpConnectionManager = amqp.connect([options.url])

  const channel: ChannelWrapper = connection.createChannel({
    json: false,
    setup: async (ch: ConfirmChannel) => {
      await declareTopology(ch, topology)
    },
  })

  return {
    publisher: {
      async publish(exchange, routingKey, content, publishOptions) {
        await channel.publish(exchange, routingKey, content, { ...publishOptions })
      },
    },

    consume(queue, prefetch, handler) {
      void channel.addSetup(async (ch: ConfirmChannel) => {
        await ch.prefetch(prefetch)
        await ch.consume(queue, (message) => {
          if (message === null) return

          void handler({
            content: message.content,
            headers: message.properties.headers ?? {},
            routingKey: message.fields.routingKey,
          }).then(
            (outcome) => {
              if (outcome === 'ack') ch.ack(message)
              else ch.nack(message, false, true)
            },
            () => {
              // Handler tidak boleh melempar — pembungkus di consumer.ts sudah
              // menangkap semuanya. Kalau tetap terjadi, kembalikan ke antrian
              // agar pesannya tidak hilang.
              ch.nack(message, false, true)
            },
          )
        })
      })
    },

    resource: {
      name: 'rabbitmq',
      start: async () => {
        await channel.waitForConnect()
      },
      stop: async () => {
        await channel.close()
        await connection.close()
      },
    },
  }
}

export async function declareTopology(channel: ConfirmChannel, topology: Topology): Promise<void> {
  for (const exchange of topology.exchanges) {
    await channel.assertExchange(exchange.name, exchange.type, { durable: exchange.durable })
  }

  for (const queue of topology.queues) {
    await channel.assertQueue(queue.name, {
      durable: queue.durable,
      ...(queue.arguments === undefined ? {} : { arguments: { ...queue.arguments } }),
    })
  }

  for (const binding of topology.bindings) {
    await channel.bindQueue(binding.queue, binding.exchange, binding.routingKey)
  }
}
