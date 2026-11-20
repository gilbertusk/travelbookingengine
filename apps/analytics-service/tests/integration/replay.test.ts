import { randomUUID } from 'node:crypto'
import { DEAD_LETTER_TOPIC, EVENT_TYPES, topicFor } from '@tbe/event-contracts'
import { createKafkaClient } from '@tbe/messaging'
import { createLogger, type ManagedResource } from '@tbe/shared-kernel'
import type { Admin, Producer } from 'kafkajs'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { replay } from '../../src/application/replay.js'
import { ANALYTICS_TOPICS, analyticsConsumer } from '../../src/composition/consumer.js'
import type { CounterRow } from '../../src/domain/summary.js'
import { createKafkaOffsets } from '../../src/infrastructure/kafka-offsets.js'
import { createPrismaAnalyticsStore } from '../../src/infrastructure/prisma-analytics-store.js'
import { createPrismaClient } from '../../src/infrastructure/prisma-client.js'
import { sampleMessage } from '../../src/testing/events.js'
import { analyticsInfra } from './env.js'

/**
 * Bukti replay Step 27: agregat dibangun dari Kafka SUNGGUHAN, DIHAPUS, lalu
 * dibangun ulang dari awal topik — dan hasilnya sama persis.
 *
 * Perangkaian consumer yang dipakai adalah `analyticsConsumer`, fungsi yang
 * sama dengan index.ts. Selain itu dibuktikan bahwa analitik tidak mengganggu
 * alur utama: offset consumer group lain tidak bergeser, dan tidak ada satu
 * pesan pun yang ditulis ke dead letter meski analitik membaca pesan cacat.
 *
 * Broker mungkin dipakai bersama (jalur env `INTEGRATION_*`), jadi topik
 * dapat memuat pesan dari jalannya uji sebelumnya. Karena itu yang
 * dibandingkan adalah SELURUH agregat sebelum dan sesudah replay — benar
 * apa pun isi topiknya — ditambah penanda khusus jalannya uji ini (kota dan
 * pemesanan acak) untuk memastikan pesan yang baru diterbitkan memang terbaca.
 */

const { databaseUrl, kafkaBrokers } = analyticsInfra()
const logger = createLogger({ serviceName: 'analytics-it', level: 'silent' })
const prisma = createPrismaClient(databaseUrl)
const store = createPrismaAnalyticsStore(prisma)
const kafka = createKafkaClient({ clientId: 'analytics-it', brokers: kafkaBrokers })
const GROUP = `analytics-it-${randomUUID()}`
const MAIN_GROUP = `main-flow-it-${randomUUID()}`
const RUN_CITY = `kota-${randomUUID().slice(0, 8)}`
const RUN_BOOKING = randomUUID()
const FOREVER = { from: '1970-01-01', to: '2999-12-31' }

let admin: Admin
let producer: Producer
const deadLetters: string[] = []

beforeAll(async () => {
  admin = kafka.admin()
  producer = kafka.producer()
  await Promise.all([admin.connect(), producer.connect()])
})

afterAll(async () => {
  await Promise.allSettled([admin.disconnect(), producer.disconnect(), prisma.$disconnect()])
})

function consumer(): ManagedResource {
  return analyticsConsumer({
    kafka,
    groupId: GROUP,
    deps: { store, clock: { now: () => new Date() }, logger },
    logger,
    onDeadLetter: (topic) => deadLetters.push(topic),
  })
}

/** Setiap jenis peristiwa satu kali, tiga pencarian berkota khusus, satu duplikat, satu cacat. */
async function publishRun(): Promise<void> {
  const messages = [
    ...EVENT_TYPES.map((type) => sampleMessage(type, { bookingId: RUN_BOOKING })),
    ...[1, 2, 3].map(() => {
      const message = sampleMessage('search.performed')
      return { ...message, payload: { ...message.payload, city: RUN_CITY } }
    }),
  ]
  const duplicate = messages[0]
  if (duplicate === undefined) throw new Error('tidak ada pesan')

  for (const message of [...messages, duplicate]) {
    await producer.send({
      topic: topicFor(message.eventType).name,
      messages: [{ key: RUN_BOOKING, value: JSON.stringify(message) }],
    })
  }
  // Pesan cacat di topik yang hanya dibaca analitik: consumer lain yang
  // kebetulan berjalan di broker bersama tidak ikut mengirimnya ke dead letter.
  await producer.send({ topic: 'tbe.search.v1', messages: [{ key: 'x', value: '{cacat' }] })
}

/**
 * Offset ter-commit group sama dengan ujung setiap partisi setiap topik.
 *
 * Offset negatif adalah penanda, bukan posisi: `-1` belum pernah di-commit,
 * `-2` "paling awal" — yang ditulis `resetOffsets({ earliest: true })`.
 * Keduanya berarti posisi `low`. Partisi kosong tidak pernah di-commit ulang
 * consumer, jadi tanpa ini partisi kosong tidak pernah "terkejar" — versi
 * pertama uji ini menunggu selamanya karenanya.
 */
async function caughtUp(groupId: string): Promise<boolean> {
  const committed = await admin.fetchOffsets({ groupId, topics: [...ANALYTICS_TOPICS] })
  for (const topic of committed) {
    const ends = await admin.fetchTopicOffsets(topic.topic)
    for (const end of ends) {
      const mine = topic.partitions.find((partition) => partition.partition === end.partition)
      const offset = mine === undefined || mine.offset.startsWith('-') ? end.low : mine.offset
      if (offset !== end.high) return false
    }
  }
  return true
}

async function waitCaughtUp(): Promise<void> {
  await vi.waitFor(
    async () => {
      expect(await caughtUp(GROUP)).toBe(true)
    },
    { timeout: 90_000, interval: 500 },
  )
}

function sorted(rows: readonly CounterRow[]): string[] {
  return rows.map((row) => `${row.metric}|${row.dimension}|${String(row.value)}`).toSorted()
}

async function endOffsets(topic: string): Promise<string> {
  return JSON.stringify(await admin.fetchTopicOffsets(topic))
}

async function mainFlowOffsets(): Promise<string> {
  return JSON.stringify(
    await admin.fetchOffsets({ groupId: MAIN_GROUP, topics: ['tbe.booking.v1'] }),
  )
}

describe('replay dari awal topik', () => {
  test('hapus agregat lalu bangun ulang: hasilnya sama persis, dan alur utama tidak terganggu', async () => {
    // Consumer group "alur utama" dengan offset di ujung topik pemesanan.
    const bookingEnds = await admin.fetchTopicOffsets('tbe.booking.v1')
    await admin.setOffsets({
      groupId: MAIN_GROUP,
      topic: 'tbe.booking.v1',
      partitions: bookingEnds.map((end) => ({ partition: end.partition, offset: end.high })),
    })
    const mainBefore = await mainFlowOffsets()
    const deadLetterBefore = await endOffsets(DEAD_LETTER_TOPIC)

    await publishRun()

    // 1. Bangun pertama. Replay ditolak selama consumer masih anggota group.
    const first = consumer()
    await first.start?.()
    try {
      await waitCaughtUp()
      const refused = await replay(
        { store, offsets: createKafkaOffsets(admin) },
        { groupId: GROUP, topics: ANALYTICS_TOPICS },
      )
      expect(refused.kind).toBe('group_active')
    } finally {
      await first.stop()
    }

    const built = await store.counters(FOREVER)
    const city = built.find((row) => row.metric === 'city.searches' && row.dimension === RUN_CITY)
    expect(city?.value).toBe(3)
    expect(deadLetters).toContain(DEAD_LETTER_TOPIC)
    const processedFirst = await store.processedCount()

    // 2. Hapus. Tunggu broker menyatakan group kosong, lalu replay SEKALI.
    //    Tidak dibungkus waitFor: `resetOffsets` kafkajs bergabung ke group
    //    lewat consumer sementara (~8 detik per topik), dan percobaan ulang
    //    yang menimpa percobaan yang belum selesai meninggalkan anggota
    //    sementara itu di group — ditemukan versi pertama uji ini.
    const offsets = createKafkaOffsets(admin)
    await vi.waitFor(
      async () => {
        expect((await offsets.check(GROUP)).kind).toBe('idle')
      },
      { timeout: 30_000, interval: 500 },
    )
    const outcome = await replay({ store, offsets }, { groupId: GROUP, topics: ANALYTICS_TOPICS })
    expect(outcome.kind).toBe('rewound')
    expect(await store.counters(FOREVER)).toEqual([])
    expect(await store.processedCount()).toBe(0)
    expect(await caughtUp(GROUP)).toBe(false)

    // 3. Bangun ulang dari awal topik.
    const second = consumer()
    await second.start?.()
    try {
      await waitCaughtUp()
    } finally {
      await second.stop()
    }

    expect(sorted(await store.counters(FOREVER))).toEqual(sorted(built))
    expect(await store.processedCount()).toBe(processedFirst)

    // 4. Alur utama: offset group lain tidak bergeser, dead letter tidak bertambah.
    expect(await mainFlowOffsets()).toBe(mainBefore)
    expect(await endOffsets(DEAD_LETTER_TOPIC)).toBe(deadLetterBefore)
  })
})
