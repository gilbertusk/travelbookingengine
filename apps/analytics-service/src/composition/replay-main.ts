import { createKafkaClient } from '@tbe/messaging'
import { createLogger } from '@tbe/shared-kernel'
import { replay } from '../application/replay.js'
import { loadConfig } from '../config.js'
import { createKafkaOffsets } from '../infrastructure/kafka-offsets.js'
import { createPrismaAnalyticsStore } from '../infrastructure/prisma-analytics-store.js'
import { createPrismaClient } from '../infrastructure/prisma-client.js'
import { ANALYTICS_TOPICS } from './consumer.js'

/**
 * `pnpm --filter @tbe/analytics-service replay`
 *
 * Membangun ulang seluruh agregat dari awal topik. Hentikan analytics-service
 * lebih dulu; skrip menolak bila consumer group masih punya anggota. Setelah
 * selesai, nyalakan service — ia membaca dari awal setiap topik.
 */

const config = loadConfig()
const logger = createLogger({
  serviceName: `${config.SERVICE_NAME}-replay`,
  level: config.LOG_LEVEL,
})
const prisma = createPrismaClient(config.DATABASE_URL)
const admin = createKafkaClient({
  clientId: `${config.SERVICE_NAME}-replay`,
  brokers: [config.KAFKA_BROKERS],
}).admin()

await admin.connect()
try {
  const outcome = await replay(
    { store: createPrismaAnalyticsStore(prisma), offsets: createKafkaOffsets(admin) },
    { groupId: config.KAFKA_GROUP_ID, topics: ANALYTICS_TOPICS },
  )
  if (outcome.kind === 'group_active') {
    logger.error(
      { groupId: config.KAFKA_GROUP_ID, members: outcome.members, state: outcome.state },
      'consumer group masih aktif — hentikan analytics-service lalu ulangi',
    )
    process.exitCode = 1
  } else {
    logger.info(
      { groupId: config.KAFKA_GROUP_ID, topics: outcome.topics },
      'agregat dikosongkan dan offset diputar ke awal; nyalakan analytics-service',
    )
  }
} finally {
  await admin.disconnect()
  await prisma.$disconnect()
}
