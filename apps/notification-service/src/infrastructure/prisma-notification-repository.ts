import { z } from 'zod'
import { VOUCHER_NOT_READY } from '../domain/delivery.js'
import type { NotificationRepository, RequestOutcome, Settlement } from '../application/ports.js'
import type {
  ClaimedNotification,
  NotificationContext,
  NotificationRequest,
  NotificationType,
} from '../domain/notification.js'
import type { Prisma, PrismaClient } from '../generated/prisma/client.js'

/**
 * Catatan pemberitahuan di Postgres. Diuji terhadap Postgres sungguhan di
 * tests/integration — batasan UNIK dan SKIP LOCKED tidak dapat dibuktikan
 * palsuan mana pun.
 */

export interface IdSource {
  next(): string
}

const money = z.object({ amountMinor: z.number().int(), currency: z.enum(['IDR', 'USD']) })

/**
 * Bentuk `context` di basis data. Ditulis service ini sendiri, tetapi tetap
 * diurai: baris yang ditulis versi lama service adalah masukan dari luar bagi
 * versi yang membacanya.
 */
const contextSchema: z.ZodType<NotificationContext> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('booking_confirmed') }),
  z.object({ type: z.literal('booking_failed') }),
  z.object({
    type: z.literal('manual_review'),
    concern: z.enum(['room', 'refund', 'unspecified']),
  }),
  z.object({
    type: z.literal('booking_cancelled'),
    reason: z.enum(['user_request', 'payment_failed', 'supplier_rejected', 'unspecified']),
    refund: money.nullable(),
  }),
  z.object({ type: z.literal('refund_completed'), amount: money.nullable() }),
])

interface ClaimedRow {
  readonly id: string
  readonly type: NotificationType
  readonly lease_until: Date
  readonly booking_id: string
  readonly user_id: string | null
  readonly dedupe_key: string
  readonly attempts: number
  readonly correlation_id: string
  readonly context: unknown
}

export function createPrismaNotificationRepository(
  prisma: PrismaClient,
  ids: IdSource,
): NotificationRepository {
  return {
    request: async (request, now) => await insertOrNudge(prisma, { id: ids.next(), request, now }),
    claimNext: async (now, leaseMs) => await claimNext(prisma, { now, leaseMs }),

    async settle(claimed, settlement, now) {
      // Bersyarat pada sewa yang SAMA: penghantar yang sewanya sudah habis dan
      // diambil alih tidak menimpa hasil penggantinya.
      const updated = await prisma.notification.updateMany({
        where: { id: claimed.id, status: 'SENDING', leaseUntil: claimed.leaseUntil },
        data: { ...settlementData(settlement), leaseUntil: null, updatedAt: now },
      })
      return updated.count === 1
    },

    async sentToRecipientSince(recipientKey, since) {
      return await prisma.notification.count({
        where: { recipientKey, status: 'SENT', sentAt: { gte: since } },
      })
    },
  }
}

async function insertOrNudge(
  prisma: PrismaClient,
  input: { readonly id: string; readonly request: NotificationRequest; readonly now: Date },
): Promise<RequestOutcome> {
  const { id, request, now } = input
  // createMany + skipDuplicates adalah INSERT ... ON CONFLICT DO NOTHING:
  // baris kedua dengan dedupe_key yang sama ditolak basis data, tanpa galat
  // dan tanpa pemeriksaan lebih dulu yang dapat berpacu.
  const created = await prisma.notification.createMany({
    data: [
      {
        id,
        bookingId: request.bookingId,
        userId: request.userId,
        type: request.context.type,
        dedupeKey: request.dedupeKey,
        source: request.source,
        sourceMessageId: request.sourceMessageId,
        correlationId: request.correlationId,
        context: request.context,
        nextAttemptAt: now,
        createdAt: now,
        updatedAt: now,
      },
    ],
    skipDuplicates: true,
  })
  if (created.count === 1) return { kind: 'created', id }

  await wakeVoucherWaiter(prisma, request.dedupeKey, now)
  return { kind: 'duplicate' }
}

/**
 * Duplikat membangunkan HANYA baris yang menunggu voucher. Yang masih dalam
 * jenjang tunda dimajukan; yang sudah DEAD karena vouchernya terlambat
 * dihidupkan lagi dengan hitungan percobaan baru — pengguna yang sudah
 * membayar tetap menerima konfirmasinya. Baris yang sedang disewa (SENDING)
 * tidak disentuh: memajukannya membuat penghantar lain mengambilnya selagi
 * yang pertama masih mengirim.
 */
async function wakeVoucherWaiter(
  prisma: PrismaClient,
  dedupeKey: string,
  now: Date,
): Promise<void> {
  const waiting = { dedupeKey, lastError: VOUCHER_NOT_READY }
  await prisma.notification.updateMany({
    where: { ...waiting, status: 'PENDING', nextAttemptAt: { gt: now } },
    data: { nextAttemptAt: now, updatedAt: now },
  })
  await prisma.notification.updateMany({
    where: { ...waiting, status: 'DEAD' },
    data: { status: 'PENDING', attempts: 0, nextAttemptAt: now, updatedAt: now },
  })
}

/**
 * Mengambil dan menyewa baris jatuh tempo dalam SATU pernyataan. SKIP LOCKED
 * membuat dua penghantar yang berpacu mengambil baris berbeda, bukan saling
 * menunggu atau mengambil baris yang sama.
 */
async function claimNext(
  prisma: PrismaClient,
  input: { readonly now: Date; readonly leaseMs: number },
): Promise<ClaimedNotification | undefined> {
  const { now } = input
  const leaseUntil = new Date(now.getTime() + input.leaseMs)
  // Sewa yang habis (status masih SENDING) berarti penghantarnya mati di
  // tengah jalan; mengambilnya lagi dihitung sebagai satu percobaan, supaya
  // baris yang selalu mematikan penghantar akhirnya berhenti di DEAD.
  const rows = await prisma.$queryRaw<ClaimedRow[]>`
    UPDATE notifications
    SET status = 'SENDING',
        attempts = CASE WHEN status = 'SENDING' THEN attempts + 1 ELSE attempts END,
        lease_until = ${leaseUntil},
        updated_at = ${now}
    WHERE id = (
      SELECT id FROM notifications
      WHERE (status = 'PENDING' AND next_attempt_at <= ${now})
         OR (status = 'SENDING' AND lease_until < ${now})
      ORDER BY next_attempt_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, type, booking_id, user_id, dedupe_key, attempts, correlation_id, lease_until, context`
  const [row] = rows
  return row === undefined ? undefined : toClaimed(row)
}

/**
 * `context` yang tidak lolos skema TIDAK dilempar: lemparan di sini terjadi
 * sesudah baris tersewa, dan baris beracun yang selalu terambil pertama akan
 * menghentikan seluruh penghantaran. Ia diserahkan sebagai `null`, dan
 * penghantar mencatatnya DEAD.
 */
function toClaimed(row: ClaimedRow): ClaimedNotification {
  const context = contextSchema.safeParse(row.context)
  return {
    id: row.id,
    type: row.type,
    bookingId: row.booking_id,
    userId: row.user_id,
    dedupeKey: row.dedupe_key,
    attempts: row.attempts,
    correlationId: row.correlation_id,
    leaseUntil: row.lease_until,
    context: context.success ? context.data : null,
  }
}

function settlementData(settlement: Settlement): Prisma.NotificationUpdateInput {
  switch (settlement.kind) {
    case 'sent':
      return {
        status: 'SENT',
        sentAt: settlement.at,
        recipientKey: settlement.recipientKey,
        userId: settlement.userId,
        lastError: null,
      }
    case 'failed':
      return {
        status: 'FAILED',
        lastError: settlement.reason,
        recipientKey: settlement.recipientKey,
      }
    case 'skipped':
      return { status: 'SKIPPED', lastError: settlement.reason }
    case 'retry':
      return {
        status: 'PENDING',
        attempts: settlement.attempts,
        nextAttemptAt: settlement.nextAttemptAt,
        lastError: settlement.reason,
      }
    case 'dead':
      return { status: 'DEAD', attempts: settlement.attempts, lastError: settlement.reason }
    case 'deferred':
      return {
        status: 'PENDING',
        nextAttemptAt: settlement.until,
        recipientKey: settlement.recipientKey,
        lastError: 'rate_limited',
      }
  }
}
