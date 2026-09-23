/**
 * @tbe/event-contracts
 *
 * Satu-satunya sumber kebenaran bentuk pesan antar service.
 *
 * Package ini sengaja tidak mengenal Kafka maupun RabbitMQ. Ia hanya tahu ada
 * dua jenis pesan — peristiwa dan perintah — dan bahwa keduanya berbeda.
 * Pemilihan transport tinggal di @tbe/messaging.
 */

export {
  createMessage,
  envelopeSchema,
  messageSchema,
  moneySchema,
  type CreateMessageInput,
  type Envelope,
  type Message,
  type Money,
} from './envelope.js'

export {
  EVENT_PAYLOADS,
  EVENT_SCHEMAS,
  EVENT_TYPES,
  isEventType,
  type EventPayload,
  type EventType,
} from './events.js'

export {
  COMMAND_PAYLOADS,
  COMMAND_SCHEMAS,
  COMMAND_TYPES,
  isCommandType,
  queueNameFor,
  type CommandPayload,
  type CommandType,
} from './commands.js'

export {
  DEAD_LETTER_TOPIC,
  TOPICS,
  topicFor,
  unmappedEvents,
  type PartitionKeySource,
  type TopicDefinition,
} from './topics.js'
