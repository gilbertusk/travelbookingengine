import { DEAD_LETTER_TOPIC, TOPICS } from '@tbe/event-contracts'
import { createKafkaClient } from '../kafka/client.js'

/**
 * Membuat seluruh topik Kafka dari definisi di @tbe/event-contracts.
 *
 * Pembuatan otomatis oleh broker sengaja dimatikan (lihat docker-compose.yml).
 * Dengan pembuatan otomatis, salah ketik nama topik pada producer tidak
 * menghasilkan galat apa pun: Kafka membuat topik baru bernama salah, pesan
 * masuk ke sana, dan tidak ada consumer yang membacanya. Kegagalan seperti itu
 * tidak bersuara dan baru ketahuan ketika data yang dinanti tidak pernah tiba.
 *
 * Skrip ini idempoten — topik yang sudah ada dilewati.
 */

const DEAD_LETTER_RETENTION_MS = 30 * 86_400_000
const DEAD_LETTER_PARTITIONS = 3

async function main(): Promise<void> {
  const brokers = (process.env.KAFKA_BROKERS ?? 'localhost:29092').split(',')
  const admin = createKafkaClient({ brokers, clientId: 'tbe-topic-admin' }).admin()

  await admin.connect()

  try {
    const existing = new Set(await admin.listTopics())
    const wanted = [
      ...TOPICS.map((topic) => ({
        topic: topic.name,
        numPartitions: topic.partitions,
        replicationFactor: 1,
        configEntries: [{ name: 'retention.ms', value: String(topic.retentionMs) }],
      })),
      {
        topic: DEAD_LETTER_TOPIC,
        numPartitions: DEAD_LETTER_PARTITIONS,
        replicationFactor: 1,
        configEntries: [{ name: 'retention.ms', value: String(DEAD_LETTER_RETENTION_MS) }],
      },
    ]

    const missing = wanted.filter((topic) => !existing.has(topic.topic))

    if (missing.length === 0) {
      process.stdout.write('Seluruh topik sudah ada.\n')
      return
    }

    await admin.createTopics({ topics: missing, waitForLeaders: true })

    for (const topic of missing) {
      process.stdout.write(`dibuat: ${topic.topic} (${String(topic.numPartitions)} partisi)\n`)
    }
  } finally {
    await admin.disconnect()
  }
}

await main()
