import { execFileSync } from 'node:child_process'
import pg from 'pg'
import { integrationEnv } from './env.js'

/**
 * Basis data uji dibangun ulang dari MIGRASI, bukan dari skema, setiap kali.
 *
 * Skema publik dibuang lalu `prisma migrate deploy` dijalankan: yang diuji
 * adalah basis data persis seperti yang akan ada di produksi, termasuk CHECK
 * dan trigger yang ditulis tangan. Membersihkan tabel satu per satu tidak
 * mungkin — trigger append-only menolak DELETE dan TRUNCATE pada
 * booking_events, dan memang harus.
 */
export default async function setup(): Promise<void> {
  const { databaseUrl } = integrationEnv()
  const client = new pg.Client({ connectionString: databaseUrl })
  await client.connect()
  await client.query('DROP SCHEMA IF EXISTS public CASCADE')
  await client.query('CREATE SCHEMA public')
  await client.end()

  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  })
}
