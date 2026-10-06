import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureTopics } from '@tbe/messaging'
import {
  createDatabases,
  deployMigrations,
  startKafka,
  startPostgres,
  startRabbit,
  startRedis,
  type Started,
} from '@tbe/testing-infra'
import pg from 'pg'
import type { TestProject } from 'vitest/node'
import { infraFromEnv, type IntegrationInfra } from './env.js'

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/**
 * Infrastruktur uji integrasi: dari env `INTEGRATION_*` bila diisi, selain itu
 * kontainer Testcontainers (Step 20).
 *
 * Basis data uji dibangun ulang dari MIGRASI, bukan dari skema, setiap kali.
 * Skema publik dibuang lalu `prisma migrate deploy` dijalankan: yang diuji
 * adalah basis data persis seperti yang akan ada di produksi, termasuk CHECK
 * dan trigger yang ditulis tangan. Membersihkan tabel satu per satu tidak
 * mungkin — trigger append-only menolak DELETE dan TRUNCATE pada
 * booking_events, dan memang harus.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const started: Started[] = []
  try {
    const infra = infraFromEnv(process.env) ?? (await startContainers(started))

    await resetSchema(infra.databaseUrl)
    await deployMigrations(APP_DIR, infra.databaseUrl)
    await ensureTopics({ brokers: infra.kafkaBrokers, clientId: 'booking-it-setup' })

    project.provide('integration', infra)
  } catch (error) {
    await stopAll(started)
    throw error
  }

  return async () => {
    await stopAll(started)
  }
}

async function startContainers(started: Started[]): Promise<IntegrationInfra> {
  const [postgres, redis, rabbit, kafka] = await Promise.all([
    startPostgres(),
    startRedis(),
    startRabbit(),
    startKafka(),
  ])
  started.push(postgres, redis, rabbit, kafka)
  await createDatabases(postgres.url('postgres'), ['booking_it'])

  return {
    databaseUrl: postgres.url('booking_it'),
    // DB 5, sama dengan jalur env: kunci uji tidak pernah bercampur dengan
    // DB 0 yang dipakai service bila Redis-nya dipakai bersama.
    redisUrl: `${redis.url}/5`,
    kafkaBrokers: kafka.brokers,
    rabbitmqUrl: rabbit.url,
  }
}

async function resetSchema(databaseUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl })
  await client.connect()
  await client.query('DROP SCHEMA IF EXISTS public CASCADE')
  await client.query('CREATE SCHEMA public')
  await client.end()
}

async function stopAll(started: readonly Started[]): Promise<void> {
  await Promise.allSettled(started.map(async (item) => await item.container.stop()))
}
