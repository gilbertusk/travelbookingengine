/**
 * Port transport.
 *
 * Seluruh logika perpesanan ditulis terhadap antarmuka ini, bukan terhadap
 * KafkaJS dan amqplib secara langsung. Yang diuntungkan bukan kemungkinan
 * mengganti broker — itu tidak akan terjadi — melainkan bahwa kebijakan retry,
 * validasi, dan pemulihan correlation dapat diuji tanpa broker yang berjalan.
 */

export interface PublishOptions {
  readonly headers: Readonly<Record<string, string | number>>
  readonly messageId: string
  readonly correlationId: string
  readonly persistent: true
}

export interface RabbitPublisher {
  publish(
    exchange: string,
    routingKey: string,
    content: Buffer,
    options: PublishOptions,
  ): Promise<void>
}

export interface IncomingCommand {
  readonly content: Buffer
  readonly headers: Readonly<Record<string, unknown>>
  readonly routingKey: string
}

/** Perintah selalu di-ack; percobaan ulang dilakukan dengan menerbitkan ulang. */
export type CommandOutcome = 'ack' | 'requeue'

export interface KafkaRecord {
  readonly key: string | null
  readonly value: string
  readonly headers: Readonly<Record<string, string>>
}

export interface KafkaProducerPort {
  send(topic: string, records: readonly KafkaRecord[]): Promise<void>
}

export interface IncomingEvent {
  readonly topic: string
  readonly partition: number
  readonly value: Buffer | null
  readonly headers: Readonly<Record<string, unknown>>
}
