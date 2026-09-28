import { describe, expect, test } from 'vitest'
import {
  COMPENSATION_ACTIONS,
  SAGA_DEFINITION,
  SAGA_STEPS,
  compensationPlan,
  definitionOf,
  nextDirectCompensation,
  outboxCompensations,
} from './saga-definition.js'

/**
 * Saga sebagai data. Uji di sini memeriksa TABELNYA — bukan jalannya saga —
 * karena tabel itulah yang dibaca pelaksana kompensasi, dan tabel yang salah
 * membuat pelaksana yang benar membalik hal yang salah.
 */

const MIN_REASON = 40

describe('setiap langkah punya kompensasi yang dinyatakan', () => {
  test.each(SAGA_STEPS)('%s punya definisi', (step) => {
    expect(SAGA_DEFINITION.filter((definition) => definition.name === step)).toHaveLength(1)
  })

  test('tidak ada definisi untuk langkah yang tidak ada di urutan saga', () => {
    expect(SAGA_DEFINITION.map((definition) => definition.name)).toEqual([...SAGA_STEPS])
  })

  /**
   * "Tidak ada yang perlu dibalik" adalah jawaban yang harus DITULIS beserta
   * alasannya. Pernyataan tanpa alasan tidak dapat ditinjau: pembaca tidak
   * dapat membedakan keputusan dari kelalaian.
   */
  test.each(SAGA_DEFINITION)(
    '$name: kompensasi tanpa aksi wajib menyebut alasannya',
    (definition) => {
      const compensation = definition.compensation
      if (compensation.kind === 'run') {
        expect(COMPENSATION_ACTIONS).toContain(compensation.action)
        return
      }
      expect(compensation.why.trim().length).toBeGreaterThanOrEqual(MIN_REASON)
    },
  )

  test('kompensasi yang diminta step doc 19 terpasang pada langkahnya', () => {
    expect(definitionOf('holdLocal').compensation).toMatchObject({ action: 'releaseLocalHold' })
    expect(definitionOf('awaitPayment').compensation).toMatchObject({ action: 'refundPayment' })
    expect(definitionOf('confirmSupplier').compensation).toMatchObject({
      action: 'cancelSupplierBooking',
    })
  })

  test('hold supplier dinyatakan habis sendiri — tidak ada operasi pelepasan palsu', () => {
    // Keputusan terbuka #1: tidak ada operasi pelepasan hold di supplier mana
    // pun. Yang dinyatakan adalah fakta itu, bukan fungsi kosong.
    expect(definitionOf('holdSupplier').compensation.kind).toBe('lapses')
  })

  test('hanya langkah yang idempoten yang boleh diulang otomatis', () => {
    // Hold supplier tanpa kunci idempotensi yang diulang menahan unit kedua.
    const retryable = SAGA_DEFINITION.filter((step) => step.retryable).map((step) => step.name)

    expect(retryable).toEqual(['confirmSupplier', 'issueVoucher'])
  })

  test('kompensasi yang menyentuh Redis berjalan langsung; yang ke service lain lewat outbox', () => {
    // Redis tidak dapat ikut transaksi basis data; perintah ke service lain
    // dapat — lewat outbox — dan harus.
    expect(definitionOf('holdLocal').compensation).toMatchObject({ via: 'direct' })
    expect(definitionOf('awaitPayment').compensation).toMatchObject({ via: 'outbox' })
    expect(definitionOf('confirmSupplier').compensation).toMatchObject({ via: 'outbox' })
  })

  test('langkah yang tidak dikenal adalah cacat program', () => {
    // @ts-expect-error menguji jalur yang tidak dapat dicapai lewat tipe
    expect(() => definitionOf('tidakAda')).toThrow(/tidak punya definisi/)
  })
})

describe('rencana kompensasi', () => {
  test('mundur dari langkah terakhir yang berhasil sampai langkah pertama', () => {
    expect(compensationPlan('awaitPayment').map((step) => step.name)).toEqual([
      'awaitPayment',
      'holdSupplier',
      'holdLocal',
      'priceCheck',
    ])
  })

  test('US-03: supplier gagal setelah pembayaran — refund, lalu hold lokal dilepas', () => {
    const plan = compensationPlan('awaitPayment')

    expect(outboxCompensations(plan)).toEqual(['refundPayment'])
    expect(nextDirectCompensation(plan)?.name).toBe('holdLocal')
  })

  test('pembayaran gagal setelah hold: tidak ada refund, hold lokal dilepas', () => {
    const plan = compensationPlan('holdSupplier')

    expect(outboxCompensations(plan)).toEqual([])
    expect(nextDirectCompensation(plan)?.name).toBe('holdLocal')
  })

  test('kompensasi langsung berikutnya dicari mundur dari penunjuk, tidak termasuk penunjuknya', () => {
    const plan = compensationPlan('awaitPayment')

    expect(nextDirectCompensation(plan, 'holdLocal')).toBeUndefined()
  })

  test('konfirmasi terlambat membalik konfirmasinya lebih dulu, baru refund', () => {
    expect(outboxCompensations(compensationPlan('confirmSupplier'))).toEqual([
      'cancelSupplierBooking',
      'refundPayment',
    ])
  })
})
