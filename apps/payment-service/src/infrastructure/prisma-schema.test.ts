import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { WEBHOOK_OUTCOMES } from '../application/ports.js'
import { PAYMENT_STATUSES, REFUND_REASONS, REFUND_STATUSES } from '../domain/payment.js'

/**
 * Menjaga skema basis data tetap sepakat dengan tipe di kode.
 *
 * Empat enum hidup di dua tempat: sebagai union di TypeScript dan sebagai tipe
 * enum di Postgres. Keduanya harus sama persis, dan tidak ada apa pun yang
 * memaksa itu — adapter Prisma memetakan string ke string, jadi nilai yang
 * ditambahkan di satu sisi saja akan lolos kompilasi, lolos seluruh uji yang
 * memakai palsuan, lalu gagal sebagai galat Postgres pada notifikasi pertama
 * yang memakainya.
 *
 * Diperiksa dari DUA arah. Satu arah saja akan melewatkan nilai yang ada di
 * skema tetapi tidak di kode — nilai yang tidak akan pernah ditulis siapa pun,
 * dan karena itu nilai yang menyesatkan siapa pun yang membaca skemanya.
 *
 * Ini juga satu-satunya pemakaian [WEBHOOK_OUTCOMES] sebagai nilai. Cakupan uji
 * yang memperlihatkannya tidak pernah dieksekusi adalah yang memunculkan
 * pertanyaan apakah daftar itu perlu ada — dan jawabannya adalah perlu, untuk
 * uji ini.
 */

const SCHEMA = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8')

function enumValues(name: string): readonly string[] {
  const block = new RegExp(`enum ${name} \\{([^}]*)\\}`).exec(SCHEMA)

  if (block === null) throw new Error(`enum ${name} tidak ada di schema.prisma`)

  return (block[1] ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('@@') && !line.startsWith('///'))
}

describe('enum skema sepakat dengan tipe kode', () => {
  test.each([
    ['PaymentStatus', PAYMENT_STATUSES],
    ['RefundStatus', REFUND_STATUSES],
    ['RefundReason', REFUND_REASONS],
    ['WebhookOutcome', WEBHOOK_OUTCOMES],
  ])('%s', (name, expected) => {
    expect([...enumValues(name)].sort()).toEqual([...expected].sort())
  })
})

describe('penjagaan penanganan uang pada skema', () => {
  /**
   * NFR-08 diperiksa seluruh repo oleh scripts/verify-money.mjs. Yang diperiksa
   * di sini lebih sempit dan lebih tajam: bahwa setiap kolom uang pada skema INI
   * berpasangan dengan kolom mata uangnya. Kolom `amount_minor` tanpa `currency`
   * tetap lolos verify-money — ia bilangan bulat — tetapi nilainya tidak dapat
   * dibaca kembali sebagai uang.
   */
  test('setiap model yang menyimpan nilai uang juga menyimpan mata uangnya', () => {
    const models = SCHEMA.split(/^model /m).slice(1)

    for (const model of models) {
      const name = model.split(/\s/)[0] ?? 'tanpa nama'

      if (!model.includes('amountMinor')) continue

      expect(model, `model ${name} menyimpan nilai tanpa mata uang`).toContain('currency')
    }
  })

  test('tidak ada kolom pecahan biner', () => {
    // Dicocokkan pada BENTUK DEKLARASI kolom, bukan pada kata "Float" di mana
    // pun. Versi pertama uji ini mencari kata itu saja dan gagal karena komentar
    // di kepala skema menyebutkan Float untuk menjelaskan kenapa ia dilarang —
    // uji yang gagal atas penjelasan tentang aturannya, bukan atas pelanggarannya.
    // Bentuknya mengikuti scripts/verify-money.mjs, yang menegakkan NFR-08 di
    // seluruh repo.
    const columns = /^\s*\w+\s+(Float|Decimal)\b/m

    expect(SCHEMA).not.toMatch(columns)
  })

  test('kolom idempotensi memang unik', () => {
    // Ketiganya adalah seluruh mekanisme idempotensi service ini. Tanpa @unique,
    // seluruh uji balapan di repo ini masih lulus — karena palsuannya meniru
    // batasan yang tidak ada di basis data sungguhan.
    expect(SCHEMA).toMatch(/idempotencyKey String @unique/)
    expect(SCHEMA).toMatch(/requestId String @unique/)
    expect(SCHEMA).toMatch(/providerEventId String @unique/)
  })
})
