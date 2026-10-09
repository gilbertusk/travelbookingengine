import type { VoucherRepository } from '../application/ports.js'
import type { Voucher } from '../domain/voucher.js'
import type { PrismaClient, Voucher as VoucherRow } from '../generated/prisma/client.js'

/**
 * Metadata voucher di Postgres.
 *
 * `insert` tidak memeriksa lebih dulu lalu menulis — dua consumer yang
 * berpacu sama-sama akan lolos pemeriksaan itu. Ia langsung menulis, dan
 * membiarkan batasan UNIK pada booking_id yang memutuskan. Yang kalah membaca
 * baris pemenang dan mengembalikannya.
 */

/** Kode galat Prisma untuk pelanggaran batasan UNIK. */
const UNIQUE_VIOLATION = 'P2002'

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === UNIQUE_VIOLATION
  )
}

function toVoucher(row: VoucherRow): Voucher {
  return {
    id: row.id,
    bookingId: row.bookingId,
    userId: row.userId,
    objectKey: row.objectKey,
    sizeBytes: row.sizeBytes,
    issuedAt: row.issuedAt,
    confirmedAt: row.confirmedAt,
  }
}

export function createPrismaVoucherRepository(prisma: PrismaClient): VoucherRepository {
  async function findByBookingId(bookingId: string): Promise<Voucher | undefined> {
    const row = await prisma.voucher.findUnique({ where: { bookingId } })
    return row === null ? undefined : toVoucher(row)
  }

  return {
    findByBookingId,

    async insert(voucher) {
      try {
        await prisma.voucher.create({ data: { ...voucher } })
        return { kind: 'inserted' }
      } catch (error) {
        if (!isUniqueViolation(error)) throw error

        const existing = await findByBookingId(voucher.bookingId)
        // Pelanggaran UNIK tanpa baris untuk bookingId ini berarti tabrakan
        // pada object_key — token acak 256-bit yang bertabrakan. Itu bukan
        // keadaan yang dapat ditangani; dilempar apa adanya.
        if (existing === undefined) throw error

        return { kind: 'exists', existing }
      }
    },
  }
}
