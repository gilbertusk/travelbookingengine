import { fromColumns } from '@tbe/money'
import type { PayableAmount, PayableAmounts } from '../application/ports.js'
import type { PrismaClient } from '../generated/prisma/client.js'

/**
 * Nilai yang boleh ditagih, diturunkan dari peristiwa pemesanan.
 *
 * Penulisannya BERSYARAT: baris hanya diganti bila peristiwa yang membawanya
 * lebih baru daripada yang tercatat. Syarat itu dinyatakan di dalam `WHERE`,
 * bukan diperiksa lebih dulu di aplikasi — dengan pemeriksaan di aplikasi, dua
 * consumer yang memproses dua peristiwa berbeda untuk pemesanan yang sama dapat
 * sama-sama lolos, dan yang menang menjadi yang menulis paling akhir, bukan yang
 * paling baru.
 *
 * `upsert` tidak dipakai karena ia tidak dapat menolak pembaruan berdasarkan
 * nilai lama. Yang dipakai adalah `updateMany` bersyarat, lalu `createMany`
 * dengan `skipDuplicates` bila belum ada barisnya.
 */
export function createPrismaPayableAmounts(prisma: PrismaClient): PayableAmounts {
  return {
    async find(bookingId): Promise<PayableAmount | undefined> {
      const row = await prisma.payableAmount.findUnique({ where: { bookingId } })

      if (row === null) return undefined

      const amount = fromColumns(row.amountMinor, row.currency)

      if (amount === undefined) {
        throw new Error(`nilai tagihan pemesanan ${bookingId} tidak sah`)
      }

      return {
        bookingId: row.bookingId,
        amount,
        source: row.source,
        observedAt: row.observedAt,
      }
    },

    async record(entry): Promise<void> {
      const updated = await prisma.payableAmount.updateMany({
        where: {
          bookingId: entry.bookingId,
          // Peristiwa yang lebih lama tidak menimpa yang lebih baru. Kafka
          // menjamin urutan per partisi, tetapi tidak menjamin apa pun setelah
          // consumer digandakan dan satu di antaranya tersendat lalu mengejar.
          observedAt: { lte: entry.observedAt },
        },
        data: {
          amountMinor: entry.amount.amountMinor,
          currency: entry.amount.currency,
          source: entry.source,
          observedAt: entry.observedAt,
        },
      })

      if (updated.count > 0) return

      await prisma.payableAmount.createMany({
        data: [
          {
            bookingId: entry.bookingId,
            amountMinor: entry.amount.amountMinor,
            currency: entry.amount.currency,
            source: entry.source,
            observedAt: entry.observedAt,
          },
        ],
        // Nol baris terbarui punya DUA sebab: barisnya belum ada, atau barisnya
        // lebih baru. `skipDuplicates` membedakan keduanya tanpa pembacaan
        // tambahan — bila barisnya lebih baru, penyisipan ini ditolak batasan
        // kunci utama dan diabaikan, yang persis perilaku yang diinginkan.
        skipDuplicates: true,
      })
    },
  }
}
