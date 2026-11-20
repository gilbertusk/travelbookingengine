import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureTopics } from '@tbe/messaging'
import {
  createDatabases,
  deployMigrations,
  startKafka,
  startPostgres,
  type Started,
} from '@tbe/testing-infra'
import pg from 'pg'
import type { TestProject } from 'vitest/node'
import { infraFromEnv, type AnalyticsInfra } from './env.js'

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/**
 * Basis data uji dibangun ulang dari MIGRASI setiap kali — termasuk CHECK yang
 * ditulis tangan — dan topik dibuat dengan konfigurasi kontrak (ensureTopics).
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const started: Started[] = []
  try {
    const infra = infraFromEnv(process.env) ?? (await startContainers(started))

    await resetSchema(infra.databaseUrl)
    await deployMigrations(APP_DIR, infra.databaseUrl)
    await ensureTopics({ brokers: infra.kafkaBrokers, clientId: 'analytics-it-setup' })

    project.provide('analytics', infra)
  } catch (error) {
    await stopAll(started)
    throw error
  }

  return async () => {
    await stopAll(started)
  }
}

async function startContainers(started: Started[]): Promise<AnalyticsInfra> {
  const [postgres, kafka] = await Promise.all([startPostgres(), startKafka()])
  started.push(postgres, kafka)
  await createDatabases(postgres.url('postgres'), ['analytics_it'])
  return { databaseUrl: postgres.url('analytics_it'), kafkaBrokers: kafka.brokers }
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
