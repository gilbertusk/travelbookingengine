import 'dotenv/config'
import { SUPPLIER_CODES } from '@tbe/supplier-adapters'
import { PrismaPg } from '@prisma/adapter-pg'
// Klien dari dist/, bukan src/generated/. Seed dijalankan dengan
// --experimental-strip-types, yang TIDAK memetakan `.js` ke `.ts`: impor ke
// src/generated gagal ERR_MODULE_NOT_FOUND — termasuk impor internal klien
// Prisma sendiri. Ditemukan Step 20, saat seed pertama kali benar-benar
// dijalankan. Konsekuensinya: `pnpm build` wajib lebih dulu, sama seperti
// typecheck.
import { PrismaClient } from '../dist/generated/prisma/client.js'

/**
 * Mengisi tabel `suppliers` dengan kelima supplier.
 *
 * Tanpa baris-baris ini, direktori kosong dan service menyatakan dirinya
 * belum siap — itu disengaja: direktori kosong berarti tidak ada satu pun
 * supplier yang dapat dipanggil, dan service yang menerima trafik dalam
 * keadaan itu hanya akan menolak semuanya.
 *
 * Nilainya mengikuti watak masing-masing supplier pada mock-supplier. LUNA
 * diberi ambang dan jendela yang lebih longgar karena memang lambat; ZEPH
 * diberi ambang lebih tinggi karena sekitar 15% permintaannya gagal tanpa
 * suntikan apa pun, dan ambang yang biasa akan membuka pemutusnya terus.
 *
 * Kredensial TIDAK ada di sini. Yang disimpan hanya NAMA variabel env-nya.
 *
 * Jalankan: pnpm --filter @tbe/supplier-service db:seed
 */

interface SeedRow {
  readonly code: string
  readonly name: string
  readonly circuitFailureThreshold: number
  readonly circuitWindowSeconds: number
  readonly circuitOpenSeconds: number
  readonly rateLimitPerSecond: number
  readonly rateLimitBurst: number
}

const ROWS: Readonly<Record<string, Omit<SeedRow, 'code'>>> = {
  SKY: {
    name: 'SkyRooms',
    circuitFailureThreshold: 5,
    circuitWindowSeconds: 60,
    circuitOpenSeconds: 30,
    rateLimitPerSecond: 40,
    rateLimitBurst: 80,
  },
  NOVA: {
    name: 'NovaStay',
    circuitFailureThreshold: 5,
    circuitWindowSeconds: 60,
    circuitOpenSeconds: 30,
    rateLimitPerSecond: 20,
    rateLimitBurst: 40,
  },
  ORBIT: {
    name: 'OrbitBeds',
    circuitFailureThreshold: 5,
    circuitWindowSeconds: 60,
    circuitOpenSeconds: 45,
    rateLimitPerSecond: 15,
    rateLimitBurst: 30,
  },
  LUNA: {
    // Lambat, bukan rapuh. Jendelanya diperlebar supaya batas waktu yang
    // sesekali terjadi tidak menumpuk menjadi pembukaan pemutus.
    name: 'LunaTravel',
    circuitFailureThreshold: 6,
    circuitWindowSeconds: 120,
    circuitOpenSeconds: 45,
    rateLimitPerSecond: 10,
    rateLimitBurst: 20,
  },
  ZEPH: {
    // Sekitar 15% permintaannya gagal tanpa suntikan apa pun. Ambang yang
    // biasa akan membuka pemutusnya terus-menerus padahal 85% sisanya sehat.
    name: 'Zephyr',
    circuitFailureThreshold: 8,
    circuitWindowSeconds: 60,
    circuitOpenSeconds: 20,
    rateLimitPerSecond: 20,
    rateLimitBurst: 40,
  },
}

const connectionString = process.env.DATABASE_URL ?? ''
if (connectionString === '') throw new Error('DATABASE_URL belum diset')

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) })

const baseUrl = process.env.SUPPLIER_BASE_URL ?? 'http://localhost:4000'

for (const code of SUPPLIER_CODES) {
  const row = ROWS[code]
  if (row === undefined) continue

  const data = {
    ...row,
    adapter: code,
    baseUrl: `${baseUrl}/${code.toLowerCase()}`,
    isActive: true,
    // Hanya NAMA variabelnya. Nilainya tidak pernah menyentuh penyimpanan.
    credentialRef: `SUPPLIER_${code}_API_KEY`,
  }

  await prisma.supplier.upsert({ where: { code }, update: data, create: { code, ...data } })
  process.stdout.write(`  ${code} — ${row.name}\n`)
}

await prisma.$disconnect()
process.stdout.write('\nKelima supplier terdaftar.\n')
