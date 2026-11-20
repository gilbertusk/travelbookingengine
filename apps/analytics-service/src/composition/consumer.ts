import { TOPICS } from '@tbe/event-contracts'
import { consumerResource, createEventConsumer } from '@tbe/messaging'
import type { Logger, ManagedResource } from '@tbe/shared-kernel'
import type { Kafka } from 'kafkajs'
import type { AnalyticsDeps } from '../application/ports.js'
import { deadLetterObserver } from '../infrastructure/dead-letter-observer.js'
import { ANALYTICS_EVENTS, handleAnalyticsEvent } from '../messaging/analytics-events.js'

/**
 * Consumer analitik sebagai sumber daya terkelola — dipakai index.ts DAN uji
 * integrasi, supaya yang dibuktikan replay adalah perangkaian produksi.
 *
 * Seluruh topik di kontrak, KECUALI dead letter: isinya bukan peristiwa
 * bisnis, dan menghitungnya akan menghitung kegagalan orang lain sebagai
 * aktivitas.
 */
export const ANALYTICS_TOPICS: readonly string[] = TOPICS.map((topic) => topic.name)

export interface AnalyticsConsumerOptions {
  readonly kafka: Kafka
  readonly groupId: string
  readonly deps: AnalyticsDeps
  readonly logger: Logger
  /** Dipanggil setiap kali pesan cacat dilewati — uji memakainya sebagai bukti. */
  readonly onDeadLetter?: (topic: string) => void
}

export function analyticsConsumer(options: AnalyticsConsumerOptions): ManagedResource {
  return consumerResource({
    consumer: options.kafka.consumer({ groupId: options.groupId }),
    topics: ANALYTICS_TOPICS,
    handler: createEventConsumer({
      subscribedTo: ANALYTICS_EVENTS,
      producer: deadLetterObserver(options.logger, options.onDeadLetter),
      logger: options.logger,
      handle: handleAnalyticsEvent(options.deps),
    }),
  })
}
