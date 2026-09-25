import { fromColumns } from '@tbe/money'
import type { InsertOutcome, PaymentRepository } from '../application/ports.js'
import type {
  Payment,
  PaymentStatus,
  Refund,
  RefundReason,
  RefundStatus,
  SettledPayment,
} from '../domain/payment.js'
import type { PrismaClient } from '../generated/prisma/client.js'

/**
 * Adapter Prisma untuk pembayaran dan refund.
 *
 * Pemetaan dari baris ke tipe domain terjadi di sini dan hanya di sini.
 * Membiarkan tipe Prisma merembet ke lapisan aplikasi berarti setiap perubahan
 * skema menyentuh use case, dan use case tidak lagi dapat diuji tanpa basis
 * data — yang di service ini berarti tidak dapat diuji sama sekali selama Docker
 * mati.
 *
 * Dua penyisipan di berkas ini memakai `createMany` dengan `skipDuplicates`
 * alih-alih `create`. Bukan untuk menyisipkan banyak baris, melainkan untuk
 * mendapatkan `ON CONFLICT DO NOTHING` beserta jumlah baris yang benar-benar
 * masuk: `count === 0` berarti batasan UNIK menolak kita, dan itulah jawaban
 * yang dicari. `create` akan MELEMPAR pada tabrakan, dan tabrakan di sini bukan
 * kegagalan — ia jawaban yang sah.
 */

/**
 * Bentuk baris, dideklarasikan lokal alih-alih memakai tipe Prisma — pola yang
 * sama dengan auth-service.
 *
 * `status` dan `reason` diberi tipe domainnya, bukan `string`. Nilai enum di
 * basis data memang sama persis dengan union di domain, dan menyatakannya
 * begitu menghapus dua type assertion sekaligus: kalau suatu hari keduanya
 * menyimpang, yang menolak adalah compiler di sini — bukan pengguna yang
 * menerima status yang tidak dikenal.
 */
interface RefundRow {
  id: string
  requestId: string
  amountMinor: number
  currency: string
  reason: RefundReason
  status: RefundStatus
  gatewayRef: string | null
}

interface PaymentRow {
  id: string
  bookingId: string
  status: PaymentStatus
  amountMinor: number
  currency: string
  gatewayRef: string | null
  failureReason: string | null
  idempotencyKey: string
  refunds: RefundRow[]
}

export function createPrismaPaymentRepository(prisma: PrismaClient): PaymentRepository {
  return {
    findById: async (id) => await findById(prisma, id),
    insert: async (payment) => await insert(prisma, payment),
    update: async (payment) => {
      await update(prisma, payment)
    },
    insertRefund: async (payment, refund) => await insertRefund(prisma, payment, refund),
    updateRefund: async (payment, refund) => {
      await updateRefund(prisma, payment, refund)
    },
  }
}

async function findById(prisma: PrismaClient, id: string): Promise<Payment | undefined> {
  const row = await prisma.payment.findUnique({ where: { id }, include: { refunds: true } })

  return row === null ? undefined : toPayment(row)
}

async function insert(prisma: PrismaClient, payment: Payment): Promise<InsertOutcome<Payment>> {
  const inserted = await prisma.payment.createMany({
    data: [
      {
        id: payment.id,
        bookingId: payment.bookingId,
        status: payment.status,
        amountMinor: payment.amount.amountMinor,
        currency: payment.amount.currency,
        idempotencyKey: payment.idempotencyKey,
      },
    ],
    skipDuplicates: true,
  })

  if (inserted.count === 1) return { kind: 'inserted' }

  const existing = await prisma.payment.findUnique({
    where: { idempotencyKey: payment.idempotencyKey },
    include: { refunds: true },
  })

  // Baris tidak masuk DAN tidak dapat ditemukan hanya mungkin bila ia dihapus di
  // antara keduanya. Tidak ada yang menghapus pembayaran di sistem ini, jadi
  // melaporkannya sebagai tersisip lebih jujur daripada menebak.
  return existing === null
    ? { kind: 'inserted' }
    : { kind: 'conflict', existing: toPayment(existing) }
}

async function update(prisma: PrismaClient, payment: Payment): Promise<void> {
  const settled = payment.status !== 'PENDING' && payment.status !== 'FAILED'

  await prisma.payment.update({
    where: { id: payment.id },
    data: {
      status: payment.status,
      gatewayRef: settled ? payment.gatewayRef : null,
      failureReason: payment.status === 'FAILED' ? payment.failureReason : null,
    },
  })
}

async function insertRefund(
  prisma: PrismaClient,
  payment: SettledPayment,
  refund: Refund,
): Promise<InsertOutcome<Refund>> {
  // Status pembayaran dan baris refund ditulis dalam SATU transaksi. Dua
  // penulisan terpisah dapat berhenti di tengah, dan yang tertinggal adalah
  // refund tanpa status pembayaran yang menyebutkannya.
  return await prisma.$transaction(async (tx) => {
    const inserted = await tx.refund.createMany({
      data: [
        {
          id: refund.id,
          paymentId: payment.id,
          requestId: refund.requestId,
          status: refund.status,
          reason: refund.reason,
          amountMinor: refund.amount.amountMinor,
          currency: refund.amount.currency,
        },
      ],
      skipDuplicates: true,
    })

    if (inserted.count === 0) {
      const existing = await tx.refund.findUnique({ where: { requestId: refund.requestId } })

      if (existing !== null) return { kind: 'conflict', existing: toRefund(existing) }
    }

    await tx.payment.update({ where: { id: payment.id }, data: { status: payment.status } })

    return { kind: 'inserted' }
  })
}

async function updateRefund(
  prisma: PrismaClient,
  payment: SettledPayment,
  refund: Refund,
): Promise<void> {
  await prisma.$transaction([
    prisma.refund.update({
      where: { requestId: refund.requestId },
      data: {
        status: refund.status,
        ...(refund.gatewayRef === undefined ? {} : { gatewayRef: refund.gatewayRef }),
      },
    }),
    prisma.payment.update({ where: { id: payment.id }, data: { status: payment.status } }),
  ])
}

function toPayment(row: PaymentRow): Payment {
  const amount = fromColumns(row.amountMinor, row.currency)

  if (amount === undefined) {
    // Data kita sendiri yang cacat. Dilempar, bukan dikembalikan sebagai nilai:
    // tidak ada pemanggil yang dapat berbuat apa pun tentang nilai uang yang
    // tersimpan tanpa mata uang yang sah.
    throw new Error(`pembayaran ${row.id} menyimpan nilai uang yang tidak sah`)
  }

  const base = {
    id: row.id,
    bookingId: row.bookingId,
    amount,
    idempotencyKey: row.idempotencyKey,
  }

  const status = row.status

  if (status === 'PENDING') return { ...base, status }
  if (status === 'FAILED') {
    return { ...base, status, failureReason: row.failureReason ?? 'tidak disebutkan' }
  }

  if (row.gatewayRef === null) {
    throw new Error(`pembayaran ${row.id} berstatus ${status} tanpa rujukan penyedia`)
  }

  return {
    ...base,
    status,
    gatewayRef: row.gatewayRef,
    refunds: row.refunds.map(toRefund),
  }
}

function toRefund(row: RefundRow): Refund {
  const amount = fromColumns(row.amountMinor, row.currency)

  if (amount === undefined) {
    throw new Error(`refund ${row.id} menyimpan nilai uang yang tidak sah`)
  }

  return {
    id: row.id,
    requestId: row.requestId,
    amount,
    reason: row.reason,
    status: row.status,
    gatewayRef: row.gatewayRef ?? undefined,
  }
}
