import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, describe, expect, test } from 'vitest'
import { createPrismaAnalyticsStore } from '../../src/infrastructure/prisma-analytics-store.js'
import { createPrismaClient } from '../../src/infrastructure/prisma-client.js'
import { analyticsInfra } from './env.js'

/**
 * Penyimpan agregat terhadap Postgres SUNGGUHAN. Yang dibuktikan di sini tidak
 * dapat dibuktikan palsuan memori: penambahan atomik ON CONFLICT di bawah
 * penulis serentak, deduplikasi oleh kunci primer saat penulis berpacu atas
 * pesan yang sama, atomisitas transaksi, CHECK yang ditulis tangan, dan kolom
 * DATE yang dibaca kembali di zona waktu proses yang bukan UTC.
 *
 * Setiap uji memakai dimensinya sendiri (`run`), jadi urutan acak dan basis
 * data bersama tidak memengaruhi hasilnya.
 */

const { databaseUrl } = analyticsInfra()
const prisma = createPrismaClient(databaseUrl)
const store = createPrismaAnalyticsStore(prisma)
const DAY = '2026-10-25'

afterAll(async () => {
  await prisma.$disconnect()
})

async function valueOf(metric: string, dimension: string): Promise<number | undefined> {
  const rows = await store.counters({ from: DAY, to: DAY })
  return rows.find((row) => row.metric === metric && row.dimension === dimension)?.value
}

function search(eventId: string, dimension: string, by = 1) {
  return {
    eventId,
    eventType: 'search.performed',
    increments: [{ day: DAY, metric: 'city.searches' as const, dimension, by }],
  }
}

describe('penyimpan analitik di Postgres', () => {
  test('lima puluh peristiwa berbeda serentak menaikkan penghitung yang SAMA: tepat 50', async () => {
    const run = `kota-${randomUUID()}`

    const outcomes = await Promise.all(
      Array.from(
        { length: 50 },
        async () => await store.record(search(randomUUID(), run), new Date()),
      ),
    )

    expect(outcomes.every((outcome) => outcome === 'recorded')).toBe(true)
    expect(await valueOf('city.searches', run)).toBe(50)
  })

  test('sepuluh penulis serentak atas pesan yang SAMA: satu tercatat, sembilan duplikat', async () => {
    const run = `kota-${randomUUID()}`
    const eventId = randomUUID()

    const outcomes = await Promise.all(
      Array.from({ length: 10 }, async () => await store.record(search(eventId, run), new Date())),
    )

    expect(outcomes.filter((outcome) => outcome === 'recorded')).toHaveLength(1)
    expect(await valueOf('city.searches', run)).toBe(1)
  })

  test('pemetaan supplier tersimpan bersama pencatatan, dan tidak ditimpa', async () => {
    const bookingId = randomUUID()
    const unit = (supplier: 'SKY' | 'NOVA') => ({
      eventId: randomUUID(),
      eventType: 'booking.created',
      bookingSupplier: { bookingId, supplier },
      increments: [],
    })

    await store.record(unit('SKY'), new Date())
    await store.record(unit('NOVA'), new Date())

    expect(await store.supplierOf(bookingId)).toBe('SKY')
    expect(await store.supplierOf(randomUUID())).toBeUndefined()
  })

  test('kegagalan di tengah transaksi tidak meninggalkan pesan "terhitung" tanpa penghitungnya', async () => {
    // Nilai negatif dilanggar CHECK di penambahan KEDUA — setelah event_id
    // tersisip. Bila transaksinya tidak atomik, pesan itu tercatat terhitung
    // dan pembacaan ulangnya dibuang sebagai duplikat: kehilangan diam-diam.
    const eventId = randomUUID()
    const run = `kota-${randomUUID()}`
    const broken = {
      ...search(eventId, run),
      increments: [
        { day: DAY, metric: 'city.searches' as const, dimension: run, by: 1 },
        { day: DAY, metric: 'city.searches' as const, dimension: `${run}-2`, by: -1 },
      ],
    }

    await expect(store.record(broken, new Date())).rejects.toThrow()

    expect(await valueOf('city.searches', run)).toBeUndefined()
    expect(await store.record(search(eventId, run), new Date())).toBe('recorded')
  })

  test('CHECK menolak nilai negatif dan metrik kosong yang ditulis langsung', async () => {
    const client = new pg.Client({ connectionString: databaseUrl })
    await client.connect()
    try {
      const insert =
        'INSERT INTO analytics_counters (day, metric, dimension, value) VALUES ($1, $2, $3, $4)'
      await expect(client.query(insert, [DAY, 'x', 'y', -1])).rejects.toThrow(
        /analytics_counters_value_nonnegative/,
      )
      await expect(client.query(insert, [DAY, '', 'y', 1])).rejects.toThrow(
        /analytics_counters_metric_present/,
      )
    } finally {
      await client.end()
    }
  })

  test('kolom DATE dibaca kembali sebagai hari yang sama di zona waktu proses mana pun', async () => {
    const run = `kota-${randomUUID()}`
    await store.record(
      {
        eventId: randomUUID(),
        eventType: 'search.performed',
        increments: [{ day: '2026-01-31', metric: 'city.searches', dimension: run, by: 1 }],
      },
      new Date(),
    )

    const inside = await store.counters({ from: '2026-01-31', to: '2026-01-31' })
    const outside = await store.counters({ from: '2026-02-01', to: '2026-02-01' })

    expect(inside.some((row) => row.dimension === run)).toBe(true)
    expect(outside.some((row) => row.dimension === run)).toBe(false)
  })
})
