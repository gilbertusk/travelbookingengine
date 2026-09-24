import 'dotenv/config'
import { v7 as uuidv7 } from 'uuid'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../src/generated/prisma/client.js'
import {
  SEED_SOURCE_SUPPLIER,
  buildSeedPlan,
  groundTruthSchema,
  seedSourceMappings,
} from '../src/domain/catalog-seed.js'
import {
  createPrismaMappingStore,
  createPrismaPropertyStore,
} from '../src/infrastructure/prisma-catalog.js'

/**
 * Mengisi katalog properti dan pemetaan supplier dari mock-supplier.
 *
 * Pemetaan dibangun dari KEBENARAN DASAR, bukan dari pencocokan nama.
 * mock-supplier memakai seed tetap dan mengendalikan properti mana muncul di
 * supplier mana, jadi jawabannya sudah dipegang. Mencocokkan nama di sini akan
 * membekukan kesalahan pencocokan ke dalam basis data sebagai kebenaran, dan
 * seluruh pengujian sesudahnya akan mengukur kesalahan itu alih-alih
 * menemukannya.
 *
 * Idempoten. Dijalankan dua kali tidak menggandakan apa pun, dan yang lebih
 * penting: TIDAK mengubah slug properti yang sudah ada. Slug yang berubah
 * berarti setiap URL yang sudah terindeks mesin pencari menjadi 404.
 *
 * Seluruh keputusannya ada di [buildSeedPlan], yang murni dan diuji tanpa
 * Postgres. Yang di berkas ini hanya mengambil dan menulis.
 *
 * Jalankan: pnpm --filter @tbe/search-service db:seed
 */

const MOCK_SUPPLIER_URL = process.env.MOCK_SUPPLIER_URL ?? 'http://localhost:4000'

async function fetchGroundTruth(): Promise<ReturnType<typeof groundTruthSchema.parse>> {
  const response = await fetch(`${MOCK_SUPPLIER_URL}/admin/catalog`)

  if (!response.ok) {
    throw new Error(
      `mock-supplier menjawab ${String(response.status)} — jalankan "pnpm --filter @tbe/mock-supplier dev" lebih dulu`,
    )
  }

  const body = (await response.json()) as { data?: unknown }

  // Divalidasi, bukan dipercaya. Jawaban yang bentuknya berubah harus gagal di
  // sini dengan pesan yang jelas, bukan menghasilkan katalog yang separuh
  // kosong dan baru ketahuan saat pencarian.
  return groundTruthSchema.parse(body.data)
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL
  if (url === undefined || url.length === 0) {
    throw new Error('DATABASE_URL belum diset — salin .env.example menjadi .env')
  }

  const truth = await fetchGroundTruth()
  process.stdout.write(`seed: ${String(truth.properties.length)} properti dari mock-supplier\n`)

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) })
  const properties = createPrismaPropertyStore(prisma)
  const mappings = createPrismaMappingStore(prisma)

  try {
    // Properti yang sudah ada dikenali lewat pemetaan supplier semu `seed`.
    // Inilah yang membuat slug bertahan antar pemanggilan.
    const existing = await properties.existingBySource(SEED_SOURCE_SUPPLIER)
    process.stdout.write(`seed: ${String(existing.size)} properti sudah ada\n`)

    const plan = buildSeedPlan(truth, { existing, newId: () => uuidv7() })

    await properties.upsertMany(plan.properties)
    await mappings.upsertMany(plan.mappings)
    await mappings.upsertMany(seedSourceMappings(truth, plan))

    process.stdout.write(
      `seed: ${String(plan.properties.length)} properti, ${String(plan.mappings.length)} pemetaan supplier\n`,
    )

    // Katalog di Redis TIDAK diisi dari sini. Service memuatnya sendiri saat
    // startup dan pada penyegaran berkala; seed yang ikut menulis cache
    // menjadi tempat kedua yang harus benar.
    process.stdout.write('seed: selesai. Jalankan ulang search-service agar katalognya termuat.\n')
  } finally {
    await prisma.$disconnect()
  }
}

await main()
