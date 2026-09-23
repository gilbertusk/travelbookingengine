import type { ManagedResource } from '@tbe/shared-kernel'
import { Kafka, logLevel, type Consumer, type Producer } from 'kafkajs'
import type { KafkaProducerPort } from '../ports.js'
import type { EventConsumer } from './consumer.js'

/**
 * Adapter tipis ke KafkaJS. Sengaja tidak memuat kebijakan apa pun — validasi,
 * pemulihan correlation, dan penanganan pesan cacat semuanya ada di
 * publisher.ts dan consumer.ts, yang dapat diuji tanpa broker.
 */

export interface KafkaConnectionOptions {
  readonly brokers: readonly string[]
  readonly clientId: string
}

export function createKafkaClient(options: KafkaConnectionOptions): Kafka {
  return new Kafka({
    clientId: options.clientId,
    brokers: [...options.brokers],
    logLevel: logLevel.WARN,
    retry: { initialRetryTime: 300, retries: 8 },
  })
}

export function toProducerPort(producer: Producer): KafkaProducerPort {
  return {
    async send(topic, records) {
      await producer.send({
        topic,
        messages: records.map((record) => ({
          key: record.key,
          value: record.value,
          headers: { ...record.headers },
        })),
      })
    },
  }
}

export function producerResource(producer: Producer): ManagedResource {
  return {
    name: 'kafka-producer',
    start: async () => {
      await producer.connect()
    },
    stop: async () => {
      await producer.disconnect()
    },
  }
}

export interface ConsumerResourceOptions {
  readonly consumer: Consumer
  readonly topics: readonly string[]
  readonly handler: EventConsumer
}

/**
 * Consumer sebagai sumber daya terkelola.
 *
 * Penutupannya menjadi penting pada Step 19: consumer yang mati tanpa
 * menyelesaikan pesan yang sedang diproses akan membaca ulang pesan itu saat
 * menyala, dan handler yang tidak idempoten akan mengerjakannya dua kali.
 */
export function consumerResource(options: ConsumerResourceOptions): ManagedResource {
  return {
    name: 'kafka-consumer',
    start: async () => {
      await options.consumer.connect()
      await options.consumer.subscribe({
        topics: [...options.topics],
        fromBeginning: false,
      })
      await options.consumer.run({
        // Offset di-commit KafkaJS setelah eachMessage selesai tanpa melempar.
        // Handler yang melempar berarti pesan dibaca ulang — itulah kenapa
        // pesan cacat tidak boleh dilempar, lihat consumer.ts.
        eachMessage: async ({ topic, partition, message }) => {
          await options.handler({
            topic,
            partition,
            value: message.value,
            headers: message.headers ?? {},
          })
        },
      })
    },
    stop: async () => {
      await options.consumer.disconnect()
    },
  }
}
