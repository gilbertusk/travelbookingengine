import type { SessionRepository, UserRepository } from '../application/ports.js'
import type { Email } from '../domain/email.js'
import { asPasswordHash } from '../domain/password.js'
import type { RefreshSession } from '../domain/session.js'
import type { User } from '../domain/user.js'
import type { PrismaClient } from '../generated/prisma/client.js'

/**
 * Adapter Prisma untuk kedua repository.
 *
 * Pemetaan dari baris database ke tipe domain terjadi di sini dan hanya di
 * sini. Membiarkan tipe Prisma merembet ke lapisan aplikasi berarti setiap
 * perubahan skema menyentuh use case, dan use case tidak lagi dapat diuji
 * tanpa database.
 */

interface UserRow {
  id: string
  email: string
  passwordHash: string
  name: string
  createdAt: Date
  updatedAt: Date
}

interface SessionRow {
  id: string
  userId: string
  tokenHash: string
  familyId: string
  expiresAt: Date
  revokedAt: Date | null
  usedAt: Date | null
  replacedById: string | null
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email as Email,
    passwordHash: asPasswordHash(row.passwordHash),
    name: row.name,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function toSession(row: SessionRow): RefreshSession {
  return {
    id: row.id,
    userId: row.userId,
    tokenHash: row.tokenHash,
    familyId: row.familyId,
    expiresAt: row.expiresAt,
    // Prisma memakai null untuk kolom kosong; domain memakai undefined.
    // Menyatukan keduanya di batas ini mencegah pemeriksaan ganda di mana-mana.
    revokedAt: row.revokedAt ?? undefined,
    usedAt: row.usedAt ?? undefined,
    replacedById: row.replacedById ?? undefined,
  }
}

export function createPrismaUserRepository(prisma: PrismaClient): UserRepository {
  return {
    async findByEmail(email) {
      const row = await prisma.user.findUnique({ where: { email } })
      return row === null ? undefined : toUser(row)
    },

    async findById(id) {
      const row = await prisma.user.findUnique({ where: { id } })
      return row === null ? undefined : toUser(row)
    },

    async create(input) {
      return toUser(
        await prisma.user.create({
          data: {
            id: input.id,
            email: input.email,
            passwordHash: input.passwordHash,
            name: input.name,
          },
        }),
      )
    },

    async updateName(id, name) {
      try {
        return toUser(await prisma.user.update({ where: { id }, data: { name } }))
      } catch {
        // Pengguna yang tidak ada bukan kegagalan sistem. Dikembalikan sebagai
        // undefined agar use case yang memutuskan bagaimana menjawabnya.
        return undefined
      }
    },
  }
}

export function createPrismaSessionRepository(prisma: PrismaClient): SessionRepository {
  return {
    async create(session) {
      await prisma.refreshSession.create({
        data: {
          id: session.id,
          userId: session.userId,
          tokenHash: session.tokenHash,
          familyId: session.familyId,
          expiresAt: session.expiresAt,
        },
      })
    },

    async findByTokenHash(tokenHash) {
      const row = await prisma.refreshSession.findUnique({ where: { tokenHash } })
      return row === null ? undefined : toSession(row)
    },

    async markUsed(id, usedAt, replacedById) {
      await prisma.refreshSession.update({ where: { id }, data: { usedAt, replacedById } })
    },

    async revoke(id, revokedAt) {
      await prisma.refreshSession.update({ where: { id }, data: { revokedAt } })
    },

    async revokeFamily(familyId, revokedAt) {
      const result = await prisma.refreshSession.updateMany({
        // Hanya yang belum dicabut. Tanpa syarat ini, waktu pencabutan asli
        // tertimpa setiap kali keluarga dicabut ulang, dan jejak kapan
        // pencurian terdeteksi ikut hilang.
        where: { familyId, revokedAt: null },
        data: { revokedAt },
      })

      return result.count
    },
  }
}
