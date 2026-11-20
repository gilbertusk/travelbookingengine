import 'dotenv/config'
import { defineConfig } from 'prisma/config'

/**
 * Konfigurasi Prisma Migrate.
 *
 * Sejak Prisma 7, URL koneksi tidak lagi boleh berada di schema.prisma. Migrate
 * membacanya dari sini, sementara PrismaClient menerimanya lewat driver adapter
 * saat dirangkai — lihat infrastructure/prisma-client.ts.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? '',
  },
})
