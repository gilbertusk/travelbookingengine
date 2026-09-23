import { createLogger, type Logger } from '@tbe/shared-kernel'
import type { KafkaProducerPort, KafkaRecord, PublishOptions, RabbitPublisher } from './ports.js'

/**
 * Perkakas uji. Tidak ikut ter-build — lihat exclude pada tsconfig.build.json.
 */

export function silentLogger(): Logger {
  return createLogger({
    serviceName: 'messaging-test',
    level: 'silent',
    destination: {
      write(): void {
        // keluaran log tidak diuji
      },
    },
  })
}

export interface RecordedPublish {
  readonly exchange: string
  readonly routingKey: string
  readonly content: string
  readonly options: PublishOptions
}

export interface FakeRabbitPublisher extends RabbitPublisher {
  readonly published: readonly RecordedPublish[]
  failNext(): void
}

export function fakeRabbitPublisher(): FakeRabbitPublisher {
  const published: RecordedPublish[] = []
  let shouldFail = false

  return {
    published,
    failNext() {
      shouldFail = true
    },
    async publish(exchange, routingKey, content, options) {
      await Promise.resolve()

      if (shouldFail) {
        shouldFail = false
        throw new Error('broker tidak dapat dihubungi')
      }

      published.push({ exchange, routingKey, content: content.toString('utf8'), options })
    },
  }
}

export interface RecordedSend {
  readonly topic: string
  readonly records: readonly KafkaRecord[]
}

export interface FakeKafkaProducer extends KafkaProducerPort {
  readonly sent: readonly RecordedSend[]
}

export function fakeKafkaProducer(): FakeKafkaProducer {
  const sent: RecordedSend[] = []

  return {
    sent,
    async send(topic, records) {
      await Promise.resolve()
      sent.push({ topic, records })
    },
  }
}
