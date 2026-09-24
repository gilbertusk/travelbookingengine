import { describe, expect, test } from 'vitest'
import { money } from '@tbe/money'
import { toDirectory, toPricedItems } from './http-gateways.js'

/**
 * Penerjemahan jawaban service lain.
 *
 * "Internal" bukan jaminan. Service yang satu dapat dikerahkan ulang dengan
 * bentuk jawaban yang berubah, dan tanpa validasi perubahan itu baru ketahuan
 * sebagai `undefined` di tengah perhitungan harga — jauh dari tempat asalnya.
 */

function envelope(data: unknown): unknown {
  return { data, error: null }
}

describe('daftar supplier', () => {
  test('keadaan pemutus dibaca apa adanya', () => {
    const parsed = toDirectory(
      envelope([{ code: 'SKY', isActive: true, circuit: { state: 'open' } }]),
    )

    expect(parsed).toEqual([{ supplier: 'SKY', isActive: true, circuit: 'open' }])
  })

  test('keadaan yang tidak disebutkan dianggap TERTUTUP', () => {
    // Menganggapnya terbuka akan membuat seluruh supplier dilewati begitu
    // bentuk jawabannya berubah — pencarian kosong tanpa satu pun galat, dan
    // tidak ada yang memicu peringatan apa pun.
    expect(toDirectory(envelope([{ code: 'SKY', isActive: true }]))[0]?.circuit).toBe('closed')
    expect(toDirectory(envelope([{ code: 'SKY', isActive: true, circuit: {} }]))[0]?.circuit).toBe(
      'closed',
    )
  })

  test('supplier yang tidak dikenal ditolak, bukan diteruskan', () => {
    // Kode yang tidak dikenal berarti supplier-service dan search-service
    // sedang tidak sepakat. Meneruskannya menyebar ketidaksepakatan itu
    // sampai ke muatan Kafka.
    expect(() => toDirectory(envelope([{ code: 'MARS', isActive: true }]))).toThrow()
  })

  test('keadaan pemutus yang tidak dikenal ditolak', () => {
    expect(() =>
      toDirectory(envelope([{ code: 'SKY', isActive: true, circuit: { state: 'melted' } }])),
    ).toThrow()
  })

  test('jawaban yang bukan amplop ditolak', () => {
    expect(() => toDirectory([{ code: 'SKY', isActive: true }])).toThrow()
  })

  test('daftar kosong diterima', () => {
    expect(toDirectory(envelope([]))).toEqual([])
  })
})

describe('harga', () => {
  const breakdown = {
    base: money(1_000_000, 'IDR'),
    markup: money(200_000, 'IDR'),
    tax: money(132_000, 'IDR'),
    total: money(1_332_000, 'IDR'),
    taxName: 'PPN',
  }

  test('rincian diteruskan lengkap', () => {
    const parsed = toPricedItems(envelope({ priced: [{ ref: 'a', ok: true, breakdown }] }))

    expect(parsed[0]).toEqual({ ref: 'a', ...breakdown })
  })

  test('hanya yang berhasil yang diambil', () => {
    // pricing-service memisahkan yang berhasil dari yang gagal dengan sengaja.
    const parsed = toPricedItems(
      envelope({
        priced: [{ ref: 'a', ok: true, breakdown }],
        failed: [{ ref: 'b', ok: false, error: { kind: 'missing_exchange_rate' } }],
      }),
    )

    expect(parsed.map((item) => item.ref)).toEqual(['a'])
  })

  test('nilai uang tanpa mata uang ditolak', () => {
    expect(() =>
      toPricedItems(
        envelope({
          priced: [
            { ref: 'a', ok: true, breakdown: { ...breakdown, total: { amountMinor: 1_332_000 } } },
          ],
        }),
      ),
    ).toThrow()
  })

  test('harga sebagai angka telanjang ditolak', () => {
    expect(() =>
      toPricedItems(
        envelope({
          priced: [{ ref: 'a', ok: true, breakdown: { ...breakdown, total: 1_332_000 } }],
        }),
      ),
    ).toThrow()
  })

  test('daftar kosong diterima', () => {
    expect(toPricedItems(envelope({ priced: [] }))).toEqual([])
  })
})
