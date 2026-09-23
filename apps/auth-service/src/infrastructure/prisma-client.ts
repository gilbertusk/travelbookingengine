import { PrismaPg } from '@prisma/adapter-pg'
import type { ManagedResource } from '@tbe/shared-kernel'
import { PrismaClient } from '../generated/prisma/client.js'

/**
 * Klien Prisma lewat driver adapter.
 *
 * Sejak Prisma 7, URL koneksi tidak lagi dibaca dari schema.prisma. Klien
 * menerima adapter yang sudah memegang koneksinya, dan Migrate membacanya dari
 * prisma.config.ts. Pemisahan itu berarti kredensial produksi tidak pernah
 * perlu hadir dalam bentuk apa pun di dalam berkas skema.
 */

export function createPrismaClient(connectionString: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) })
}

export function prismaResource(client: PrismaClient): ManagedResource {
  return {
    name: 'database',
    start: async () => {
      // Menyambung eksplisit saat startup, bukan menunggu kueri pertama.
      // Service yang menyatakan diri siap padahal databasenya tidak dapat
      // dihubungi akan menerima trafik lalu menolak seluruhnya.
      await client.$connect()
    },
    stop: async () => {
      await client.$disconnect()
    },
  }
}
