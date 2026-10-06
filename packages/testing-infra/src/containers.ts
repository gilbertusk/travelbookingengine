import { createServer } from 'node:net'
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers'

/**
 * Infrastruktur SUNGGUHAN untuk uji integrasi, lewat Testcontainers
 * (CONVENTIONS.md bagian 10, NFR-19).
 *
 * Citra dan pengaturannya disamakan dengan infra/docker-compose.yml — versi
 * yang sama, notifikasi keyspace Redis yang sama, pembuatan topik otomatis
 * Kafka yang sama-sama MATI. Uji yang lulus terhadap broker yang dikonfigurasi
 * berbeda dari lingkungan pengembangan membuktikan hal yang berbeda pula.
 *
 * Tidak ada jalur "lewati bila Docker tidak ada". Tanpa Docker, `start()`
 * melempar dan uji gagal keras — uji integrasi yang diam-diam tidak berjalan
 * adalah persis "hijau" yang dilarang NFR-19.
 */

export const IMAGES = {
  postgres: 'postgres:16-alpine',
  redis: 'redis:7-alpine',
  rabbitmq: 'rabbitmq:3.13-management-alpine',
  kafka: 'apache/kafka:3.9.0',
} as const

/** Kredensial kontainer sekali pakai; tidak pernah menyentuh apa pun di luar uji. */
const PG_USER = 'tbe'
const PG_PASSWORD = 'tbe_it'
const RABBIT_USER = 'tbe'
const RABBIT_PASSWORD = 'tbe_it'
const KAFKA_CLUSTER_ID = 'tbe-integration-cluster-01'

export interface Started {
  readonly container: StartedTestContainer
}

export interface StartedPostgres extends Started {
  /** URL ke basis data tertentu di kontainer ini. */
  url(database: string): string
}

export async function startPostgres(): Promise<StartedPostgres> {
  const container = await new GenericContainer(IMAGES.postgres)
    .withEnvironment({
      POSTGRES_USER: PG_USER,
      POSTGRES_PASSWORD: PG_PASSWORD,
      POSTGRES_DB: 'postgres',
    })
    .withExposedPorts(5432)
    // Pesan ini muncul DUA kali: sekali untuk server sementara skrip init,
    // sekali untuk server yang sesungguhnya. Menunggu yang pertama berarti
    // terhubung ke server yang sebentar lagi dimatikan.
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start()

  const host = container.getHost()
  const port = container.getMappedPort(5432)

  return {
    container,
    url: (database) => `postgresql://${PG_USER}:${PG_PASSWORD}@${host}:${String(port)}/${database}`,
  }
}

export interface StartedRedis extends Started {
  readonly url: string
}

export async function startRedis(): Promise<StartedRedis> {
  const container = await new GenericContainer(IMAGES.redis)
    // Ex: notifikasi kunci kedaluwarsa. Pelepasan hold otomatis Step 17
    // bergantung padanya, dan booking-service menolak startup tanpanya.
    .withCommand(['redis-server', '--notify-keyspace-events', 'Ex'])
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start()

  return {
    container,
    url: `redis://${container.getHost()}:${String(container.getMappedPort(6379))}`,
  }
}

export interface StartedRabbit extends Started {
  readonly url: string
}

export async function startRabbit(): Promise<StartedRabbit> {
  const container = await new GenericContainer(IMAGES.rabbitmq)
    .withEnvironment({
      RABBITMQ_DEFAULT_USER: RABBIT_USER,
      RABBITMQ_DEFAULT_PASS: RABBIT_PASSWORD,
    })
    .withExposedPorts(5672)
    .withWaitStrategy(Wait.forLogMessage(/Server startup complete/))
    .withStartupTimeout(120_000)
    .start()

  const host = container.getHost()
  const port = container.getMappedPort(5672)

  return { container, url: `amqp://${RABBIT_USER}:${RABBIT_PASSWORD}@${host}:${String(port)}` }
}

export interface StartedKafka extends Started {
  readonly brokers: readonly string[]
}

/**
 * Kafka dengan port host yang DIKETAHUI SEBELUM kontainer menyala.
 *
 * Kafka mengumumkan alamatnya sendiri kepada klien (advertised listener), dan
 * alamat itu harus alamat yang dapat dijangkau DARI HOST — termasuk port yang
 * dipetakan Docker. Port acak yang baru diketahui setelah kontainer menyala
 * datang terlambat untuk dimasukkan ke konfigurasinya.
 *
 * Alternatif yang ditolak: modul @testcontainers/kafka. Ia menyelesaikan
 * persoalan yang sama dengan skrip pembuka, tetapi hanya untuk citra
 * confluentinc/cp-kafka — dan infra/docker-compose.yml memakai apache/kafka.
 * Menguji terhadap distribusi Kafka yang berbeda dari lingkungan pengembangan
 * ditolak demi selisih kecil ini: port bebas dipilih dulu, lalu dipetakan tetap.
 * Jendela balapan antara "port dipilih" dan "port dipakai Docker" ada, dan
 * diterima — kegagalannya keras dan jelas (port sudah dipakai), bukan diam.
 */
export async function startKafka(): Promise<StartedKafka> {
  const hostPort = await freePort()
  const container = await new GenericContainer(IMAGES.kafka)
    .withEnvironment({
      CLUSTER_ID: KAFKA_CLUSTER_ID,
      KAFKA_NODE_ID: '1',
      KAFKA_PROCESS_ROLES: 'broker,controller',
      KAFKA_CONTROLLER_QUORUM_VOTERS: '1@localhost:9093',
      KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
      KAFKA_INTER_BROKER_LISTENER_NAME: 'INTERNAL',
      KAFKA_LISTENERS: 'INTERNAL://:9092,CONTROLLER://:9093,EXTERNAL://:29092',
      KAFKA_ADVERTISED_LISTENERS: `INTERNAL://localhost:9092,EXTERNAL://localhost:${String(hostPort)}`,
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP:
        'CONTROLLER:PLAINTEXT,INTERNAL:PLAINTEXT,EXTERNAL:PLAINTEXT',
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: '1',
      KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: '1',
      KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: '1',
      KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: '0',
      KAFKA_AUTO_CREATE_TOPICS_ENABLE: 'false',
    })
    .withExposedPorts({ container: 29092, host: hostPort })
    .withWaitStrategy(Wait.forLogMessage(/Kafka Server started/))
    .withStartupTimeout(120_000)
    .start()

  return { container, brokers: [`localhost:${String(hostPort)}`] }
}

/** Port TCP yang sedang bebas di host, dipilih sistem operasi. */
export async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, () => {
      const address = server.address()
      server.close(() => {
        if (address !== null && typeof address === 'object') resolve(address.port)
        else reject(new Error('port bebas tidak dapat ditentukan'))
      })
    })
  })
}
