import 'dotenv/config'
import { v7 as uuidv7 } from 'uuid'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../src/generated/prisma/client.js'

/**
 * Mengisi tabel `exchange_rates` dan `markup_rules`.
 *
 * Tabel kurs yang kosong membuat service menyatakan dirinya BELUM SIAP, dan
 * itu disengaja: tanpa kurs, setiap harga supplier dalam dolar gagal dihitung,
 * dan gagal diam-diam untuk sebagian hasil jauh lebih buruk daripada menolak
 * trafik sejak awal.
 *
 * Baris kurs TIDAK PERNAH diperbarui di tempat. Kurs baru adalah baris baru
 * dengan `effective_from` yang lebih baru — riwayatnya itulah yang membuat
 * harga pemesanan lama tetap dapat dijelaskan berbulan-bulan kemudian.
 *
 * Jalankan: pnpm --filter @tbe/pricing-service db:seed
 */

/**
 * Kurs awal, sebagai bilangan bulat berskala.
 *
 * 16.235,75 disimpan sebagai `amount: 1623575, scale: 2`. Alasannya sama
 * dengan uang: pecahan biner tidak dapat mewakili sebagian besar kurs dengan
 * tepat, dan kesalahannya menumpuk pada setiap konversi.
 */
const RATES = [
  { from: 'USD', to: 'IDR', amount: 1_623_575, scale: 2 },
  { from: 'IDR', to: 'USD', amount: 6_159, scale: 8 },
] as const

/**
 * Satu aturan markup global sebagai titik awal.
 *
 * Operator mengubahnya lewat FR-30, bukan dengan menjalankan seed ulang.
 * Aturan yang lebih khusus — per supplier atau per kota — dibuat dari panel,
 * dan aturan ini tetap menjadi jaring pengamannya.
 */
const GLOBAL_MARKUP = {
  name: 'markup global',
  priority: 0,
  percentageBasisPoints: 1_200,
}

const EPOCH = new Date('2026-01-01T00:00:00.000Z')

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL
  if (url === undefined || url.length === 0) {
    throw new Error('DATABASE_URL belum diset — salin .env.example menjadi .env')
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) })

  try {
    for (const rate of RATES) {
      // Kunci uniknya adalah pasangan mata uang DITAMBAH waktu berlaku, jadi
      // menjalankan seed dua kali tidak menumpuk baris duplikat, dan tidak
      // pula menimpa kurs sungguhan yang sudah masuk belakangan.
      await prisma.exchangeRate.upsert({
        where: {
          fromCurrency_toCurrency_effectiveFrom: {
            fromCurrency: rate.from,
            toCurrency: rate.to,
            effectiveFrom: EPOCH,
          },
        },
        update: {},
        create: {
          id: uuidv7(),
          fromCurrency: rate.from,
          toCurrency: rate.to,
          rate: rate.amount,
          scale: rate.scale,
          effectiveFrom: EPOCH,
          source: 'seed',
        },
      })

      process.stdout.write(`seed: kurs ${rate.from} -> ${rate.to}\n`)
    }

    // Aturan markup tidak di-upsert berdasarkan nama: kalau operator sudah
    // mengubahnya, menimpanya lagi berarti diam-diam mengembalikan harga ke
    // angka yang bukan pilihan mereka.
    const existing = await prisma.markupRule.count()
    if (existing === 0) {
      await prisma.markupRule.create({
        data: {
          id: uuidv7(),
          name: GLOBAL_MARKUP.name,
          priority: GLOBAL_MARKUP.priority,
          kind: 'percentage',
          percentageBasisPoints: GLOBAL_MARKUP.percentageBasisPoints,
          isActive: true,
        },
      })

      process.stdout.write('seed: aturan markup global 12%\n')
    } else {
      process.stdout.write(`seed: ${String(existing)} aturan markup sudah ada, dilewati\n`)
    }
  } finally {
    await prisma.$disconnect()
  }
}

await main()
