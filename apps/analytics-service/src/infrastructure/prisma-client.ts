import { PrismaPg } from '@prisma/adapter-pg'
import type { ManagedResource } from '@tbe/shared-kernel'
import { PrismaClient } from '../generated/prisma/client.js'

/** Klien Prisma lewat driver adapter — pola yang sama dengan service lain. */

export function createPrismaClient(connectionString: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) })
}

export function prismaResource(client: PrismaClient): ManagedResource {
  return {
    name: 'database',
    start: async () => {
      await client.$connect()
    },
    stop: async () => {
      await client.$disconnect()
    },
  }
}
