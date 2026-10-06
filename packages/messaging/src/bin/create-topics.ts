import { ensureTopics } from '../kafka/topics.js'

/**
 * `pnpm topics:create` — lihat kafka/topics.ts untuk alasan topik dibuat lewat
 * skrip dan bukan otomatis oleh broker.
 */

async function main(): Promise<void> {
  const brokers = (process.env.KAFKA_BROKERS ?? 'localhost:29092').split(',')
  const created = await ensureTopics({ brokers })

  if (created.length === 0) {
    process.stdout.write('Seluruh topik sudah ada.\n')
    return
  }

  for (const topic of created) {
    process.stdout.write(`dibuat: ${topic.topic} (${String(topic.partitions)} partisi)\n`)
  }
}

await main()
