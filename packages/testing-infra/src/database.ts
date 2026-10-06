import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { promisify } from 'node:util'
import pg from 'pg'

const run = promisify(execFile)

/**
 * Satu basis data per service, di SATU server Postgres — sama dengan
 * infra/init-db.sh. Tanpa pemisahan ini join lintas service menjadi mungkin,
 * dan uji integrasi tidak akan menangkapnya.
 */
export async function createDatabases(adminUrl: string, names: readonly string[]): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl })
  await client.connect()

  try {
    for (const name of names) {
      // Nama berasal dari kode uji, bukan masukan pengguna; tetap diperiksa
      // supaya tidak ada satu pun pengenal SQL yang disusun dari string bebas.
      if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`nama basis data tidak sah: ${name}`)
      await client.query(`CREATE DATABASE "${name}"`)
    }
  } finally {
    await client.end()
  }
}

/**
 * `prisma migrate deploy` untuk satu service — MIGRASI, bukan `db push`.
 * Yang diuji adalah basis data persis seperti di produksi, termasuk CHECK dan
 * trigger tulisan tangan yang tidak dikenal skema Prisma.
 *
 * CLI Prisma dijalankan lewat node sendiri, bukan `npx`: di Windows `npx`
 * adalah berkas .cmd yang tidak dapat dijalankan tanpa shell (Temuan Step 19).
 * CLI-nya diambil dari dependensi SERVICE itu sendiri, supaya versi Prisma
 * yang menjalankan migrasi sama dengan yang menghasilkan kliennya.
 */
export async function deployMigrations(appDir: string, databaseUrl: string): Promise<void> {
  const prismaCli = createRequire(join(appDir, 'package.json')).resolve('prisma/build/index.js')

  await run(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    cwd: appDir,
    env: { ...process.env, DATABASE_URL: databaseUrl },
  })
}

/** Menjalankan skrip seed TypeScript milik service (`prisma/seed.ts`). */
export async function runSeed(
  appDir: string,
  env: Readonly<Record<string, string>>,
): Promise<void> {
  await run(process.execPath, ['--experimental-strip-types', 'prisma/seed.ts'], {
    cwd: appDir,
    env: { ...process.env, ...env },
  })
}
