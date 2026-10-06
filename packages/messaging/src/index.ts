/**
 * @tbe/messaging
 *
 * Pemisahan peran dua perantara pesan, ditegakkan oleh bentuk API-nya:
 *
 * - **Kafka** membawa peristiwa. `EventPublisher` hanya menerima jenis
 *   peristiwa, dan tidak ada cara mengirim perintah lewatnya.
 * - **RabbitMQ** membawa perintah. `CommandSender` hanya menerima jenis
 *   perintah, dan tidak ada cara mengirim peristiwa lewatnya.
 *
 * Batas itu tidak dapat dilanggar tanpa mengubah package ini — yang persis
 * merupakan tujuannya. Pemisahan yang hanya hidup di dokumentasi akan bocor
 * pada sore pertama yang sibuk.
 */

export {
  LAST_RETRY_TIER,
  RETRY_COUNT_HEADER,
  RETRY_TIERS,
  attemptsSoFar,
  dispositionFor,
  headerString,
  isRetryable,
  type Disposition,
  type RetryTier,
} from './retry.js'

export type {
  CommandOutcome,
  IncomingCommand,
  IncomingEvent,
  KafkaProducerPort,
  KafkaRecord,
  PublishOptions,
  RabbitPublisher,
} from './ports.js'

export {
  COMMAND_EXCHANGE,
  DEAD_LETTER_EXCHANGE,
  RETRY_EXCHANGE,
  deadLetterQueue,
  mainQueue,
  retryQueue,
  retryRoutingKey,
  topologyFor,
  type BindingDeclaration,
  type ExchangeDeclaration,
  type QueueDeclaration,
  type Topology,
} from './rabbit/topology.js'

export {
  createCommandSender,
  publishOptions,
  type CommandSender,
  type SendOptions,
} from './rabbit/sender.js'

export {
  createCommandConsumer,
  type CommandConsumer,
  type CommandHandlerOptions,
  type DeadLetterContext,
} from './rabbit/consumer.js'

export {
  createRabbitConnection,
  declareTopology,
  type RabbitConnection,
  type RabbitConnectionOptions,
  type RabbitHandler,
} from './rabbit/client.js'

export { envelopeOverrides, type EnvelopeOptions } from './envelope-options.js'

export {
  createEventPublisher,
  partitionKeyOf,
  type EventPublisher,
  type PublishEventOptions,
} from './kafka/publisher.js'

export {
  createEventConsumer,
  type EventConsumer,
  type EventHandlerOptions,
} from './kafka/consumer.js'

export {
  consumerResource,
  createKafkaClient,
  producerResource,
  toProducerPort,
  type ConsumerResourceOptions,
  type KafkaConnectionOptions,
} from './kafka/client.js'

export { ensureTopics, type EnsureTopicsOptions } from './kafka/topics.js'
