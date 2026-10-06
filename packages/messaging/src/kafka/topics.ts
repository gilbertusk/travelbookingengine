import { DEAD_LETTER_TOPIC, TOPICS } from '@tbe/event-contracts'
import { createKafkaClient } from './client.js'

/**
 * Membuat seluruh topik Kafka dari definisi di @tbe/event-contracts.
 *
 * Pembuatan otomatis oleh broker sengaja dimatikan (lihat docker-compose.yml).
 * Dengan pembuatan otomatis, salah ketik nama topik pada producer tidak
 * menghasilkan galat apa pun: Kafka membuat topik baru bernama salah, pesan
 * masuk ke sana, dan tidak ada consumer yang membacanya. Kegagalan seperti itu
 * tidak bersuara dan baru ketahuan ketika data yang dinanti tidak pernah tiba.
 *
 * Idempoten — topik yang sudah ada dilewati. Dipakai skrip `topics:create`
 * DAN uji integrasi Step 20, supaya broker di uji punya topik yang persis sama
 * dengan broker pengembangan; daftar kedua yang disalin tangan akan tertinggal
 * pada topik baru pertama.
 */

const DEAD_LETTER_RETENTION_MS = 30 * 86_400_000
const DEAD_LETTER_PARTITIONS = 3

export interface EnsureTopicsOptions {
  readonly brokers: readonly string[]
  readonly clientId?: string | undefined
}

/** Mengembalikan topik yang BARU dibuat, dengan jumlah partisinya. */
export async function ensureTopics(
  options: EnsureTopicsOptions,
): Promise<readonly { readonly topic: string; readonly partitions: number }[]> {
  const admin = createKafkaClient({
    brokers: [...options.brokers],
    clientId: options.clientId ?? 'tbe-topic-admin',
  }).admin()

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
    if (missing.length > 0) await admin.createTopics({ topics: missing, waitForLeaders: true })

    return missing.map((topic) => ({ topic: topic.topic, partitions: topic.numPartitions }))
  } finally {
    await admin.disconnect()
  }
}
