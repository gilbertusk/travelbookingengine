import pg from 'pg'
import { getContainerRuntimeClient } from 'testcontainers'
import type { InfraInfo, ServiceDatabase } from './context.js'

/**
 * Kegagalan infrastruktur untuk uji chaos (Step 28) — terhadap kontainer
 * SUNGGUHAN, bukan palsuan.
 *
 * Tiga cara mematikan, dipilih per komponen dan alasannya dicatat di sini:
 *
 * - **Membekukan** (`docker pause`) Kafka dan Redis. Proses berhenti total —
 *   tidak menjawab, tidak menutup koneksi — lalu berjalan lagi persis dari
 *   tempatnya. Menghentikan kontainer (`docker stop`) ditolak: Testcontainers
 *   memetakan port acak, dan kontainer yang dinyalakan ulang dapat mendapat
 *   port lain; Kafka bahkan mengumumkan alamatnya sendiri ke klien. Yang diuji
 *   lalu adalah "alamat broker berubah", bukan "broker mati sebentar".
 * - **Menghentikan aplikasinya** (`rabbitmqctl stop_app`) untuk RabbitMQ:
 *   proses Erlang tetap hidup, port tetap, tetapi broker menutup setiap
 *   koneksi dan menolak koneksi AMQP baru. Lebih dekat ke "broker mati" bagi
 *   klien daripada membekukan, karena klien AMQP melihat koneksinya putus dan
 *   jalur sambung ulangnya yang diuji.
 * - **Menolak koneksi** di Postgres lewat `ALLOW_CONNECTIONS false` ditambah
 *   pemutusan backend yang ada. Postgres tetap hidup; basis data satu service
 *   yang menolak — persis "PostgreSQL menolak koneksi sementara" di prompt.
 */

export type FrozenComponent = 'kafka' | 'redis'

export interface InfraControl {
  freeze(component: FrozenComponent): Promise<void>
  thaw(component: FrozenComponent): Promise<void>
  stopRabbit(): Promise<void>
  startRabbit(): Promise<void>
  /** Basis data satu service menolak koneksi baru, dan koneksi yang ada diputus. */
  refuseConnections(database: ServiceDatabase): Promise<void>
  allowConnections(database: ServiceDatabase): Promise<void>
  /** Mengembalikan semuanya — dipanggil afterEach, juga bila uji gagal di tengah. */
  restoreAll(): Promise<void>
}

export function createInfraControl(infra: InfraInfo): InfraControl {
  const frozen = new Set<FrozenComponent>()
  const refused = new Set<ServiceDatabase>()
  let rabbitStopped = false

  async function container(id: string) {
    const client = await getContainerRuntimeClient()
    return { client, handle: client.container.getById(id) }
  }

  async function rabbitctl(command: 'stop_app' | 'start_app'): Promise<void> {
    const { client, handle } = await container(infra.containers.rabbit)
    const result = await client.container.exec(handle, ['rabbitmqctl', command])
    if (result.exitCode !== 0) {
      throw new Error(`rabbitmqctl ${command} gagal (${String(result.exitCode)}): ${result.output}`)
    }
  }

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({
      connectionString: infra.postgresUrlTemplate.replace('{db}', 'postgres'),
    })
    await client.connect()
    try {
      return await fn(client)
    } finally {
      await client.end()
    }
  }

  const control: InfraControl = {
    async freeze(component) {
      const { handle } = await container(infra.containers[component])
      await handle.pause()
      frozen.add(component)
    },
    async thaw(component) {
      const { handle } = await container(infra.containers[component])
      await handle.unpause()
      frozen.delete(component)
    },
    async stopRabbit() {
      await rabbitctl('stop_app')
      rabbitStopped = true
    },
    async startRabbit() {
      await rabbitctl('start_app')
      rabbitStopped = false
    },
    async refuseConnections(database) {
      // Nama basis data dari daftar tetap DATABASES, bukan masukan luar;
      // ALTER DATABASE tidak menerima parameter terikat.
      await admin(async (client) => {
        await client.query(`ALTER DATABASE "${database}" ALLOW_CONNECTIONS false`)
        await client.query(
          'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
          [database],
        )
      })
      refused.add(database)
    },
    async allowConnections(database) {
      await admin(async (client) => {
        await client.query(`ALTER DATABASE "${database}" ALLOW_CONNECTIONS true`)
      })
      refused.delete(database)
    },
    async restoreAll() {
      for (const component of [...frozen]) await control.thaw(component)
      for (const database of [...refused]) await control.allowConnections(database)
      if (rabbitStopped) await control.startRabbit()
    },
  }

  return control
}
