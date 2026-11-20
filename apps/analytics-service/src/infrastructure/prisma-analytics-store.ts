import type { AnalyticsStore, RecordUnit } from '../application/ports.js'
import { METRICS, mergeIncrements, type Metric } from '../domain/counters.js'
import { SUPPLIER_CODES, type SupplierCode } from '../domain/facts.js'
import type { CounterRow } from '../domain/summary.js'
import type { PrismaClient } from '../generated/prisma/client.js'

/**
 * Penyimpan agregat di PostgreSQL (Step 27).
 *
 * Penambahan penghitung memakai SQL mentah, bukan `upsert` Prisma: yang
 * dibutuhkan adalah `value = analytics_counters.value + EXCLUDED.value` dalam
 * SATU pernyataan, supaya dua instance yang menambah penghitung yang sama
 * bersamaan tidak saling menimpa. Baca-ubah-tulis lewat ORM akan kehilangan
 * salah satu tambahan tanpa galat apa pun. Uji integrasi membuktikannya
 * dengan penulis serentak.
 *
 * Deduplikasi oleh kunci primer `event_id`: `ON CONFLICT DO NOTHING` lalu
 * jumlah baris yang tersisip menentukan apakah transaksi melanjutkan. Tidak
 * ada pemeriksaan "sudah ada?" di kode — dua consumer yang berpacu atas pesan
 * yang sama diserialkan oleh kunci baris Postgres, dan yang kalah melihat 0.
 */
export function createPrismaAnalyticsStore(prisma: PrismaClient): AnalyticsStore {
  return {
    async supplierOf(bookingId) {
      const row = await prisma.bookingSupplier.findUnique({ where: { bookingId } })
      return row !== null && isSupplierCode(row.supplier) ? row.supplier : undefined
    },

    async record(unit, at) {
      return await prisma.$transaction(async (tx) => {
        const inserted = await tx.$executeRaw`
          INSERT INTO analytics_processed_events (event_id, event_type, processed_at)
          VALUES (${unit.eventId}::uuid, ${unit.eventType}, ${at})
          ON CONFLICT (event_id) DO NOTHING`
        if (inserted === 0) return 'duplicate'

        await rememberSupplier(tx, unit)
        for (const increment of mergeIncrements(unit.increments)) {
          await tx.$executeRaw`
            INSERT INTO analytics_counters (day, metric, dimension, value)
            VALUES (${increment.day}::date, ${increment.metric}, ${increment.dimension}, ${increment.by})
            ON CONFLICT (day, metric, dimension)
            DO UPDATE SET value = analytics_counters.value + EXCLUDED.value`
        }
        return 'recorded'
      })
    },

    async counters(range) {
      const rows = await prisma.counter.findMany({
        where: {
          day: {
            gte: new Date(`${range.from}T00:00:00Z`),
            lte: new Date(`${range.to}T00:00:00Z`),
          },
        },
        select: { metric: true, dimension: true, value: true },
      })
      return rows.flatMap((row): CounterRow[] =>
        isMetric(row.metric)
          ? [{ metric: row.metric, dimension: row.dimension, value: Number(row.value) }]
          : [],
      )
    },

    async processedCount() {
      return await prisma.processedEvent.count()
    },

    async reset() {
      // Satu pernyataan untuk ketiganya: TRUNCATE transaksional di Postgres,
      // jadi tidak ada keadaan antara "penghitung kosong, daftar pesan masih ada".
      await prisma.$executeRaw`
        TRUNCATE analytics_counters, analytics_processed_events, analytics_booking_suppliers`
    },
  }
}

type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]

async function rememberSupplier(tx: Tx, unit: RecordUnit): Promise<void> {
  if (unit.bookingSupplier === undefined) return
  await tx.$executeRaw`
    INSERT INTO analytics_booking_suppliers (booking_id, supplier)
    VALUES (${unit.bookingSupplier.bookingId}::uuid, ${unit.bookingSupplier.supplier})
    ON CONFLICT (booking_id) DO NOTHING`
}

function isMetric(value: string): value is Metric {
  return (METRICS as readonly string[]).includes(value)
}

function isSupplierCode(value: string): value is SupplierCode {
  return (SUPPLIER_CODES as readonly string[]).includes(value)
}
