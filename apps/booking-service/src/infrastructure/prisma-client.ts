import { PrismaPg } from '@prisma/adapter-pg'
import type { ManagedResource } from '@tbe/shared-kernel'
import { PrismaClient } from '../generated/prisma/client.js'
import type { BookingDb } from './booking-db.js'

/**
 * Klien Prisma lewat driver adapter.
 *
 * Sejak Prisma 7, URL koneksi tidak lagi dibaca dari schema.prisma. Klien
 * menerima adapter yang sudah memegang koneksinya, dan Migrate membacanya dari
 * prisma.config.ts.
 */

export function createPrismaClient(connectionString: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) })
}

export function prismaResource(client: PrismaClient): ManagedResource {
  return {
    name: 'database',
    start: async () => {
      // Menyambung eksplisit saat startup, bukan menunggu kueri pertama.
      // Service yang menyatakan diri siap tanpa basis data akan menerima hold
      // yang tidak dapat disimpannya.
      await client.$connect()
    },
    stop: async () => {
      await client.$disconnect()
    },
  }
}

/**
 * Bukti compiler bahwa klien tergenerate memenuhi port [BookingDb].
 *
 * Tanpa baris ini, palsuan di testing/memory-db.ts dapat menyimpang dari klien
 * sungguhan — menerima bentuk argumen yang ditolak Prisma, atau mengembalikan
 * bentuk yang tidak pernah dikembalikan Prisma — dan seluruh uji repository
 * akan lulus terhadap basis data yang tidak ada. Dengan baris ini, setiap
 * perubahan skema yang membuat keduanya tidak sepakat menggagalkan typecheck.
 */
export function bookingDbOf(client: PrismaClient): BookingDb {
  return client
}
