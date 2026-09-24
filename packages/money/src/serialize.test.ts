import { describe, expect, test } from 'vitest'
import { format, toDecimalString } from './format.js'
import { money } from './money.js'
import { fromColumns, fromJson, moneySchema, parseMoney, toColumns, toJson } from './serialize.js'

describe('serialisasi', () => {
  test('bolak-balik tidak mengubah nilai', () => {
    for (const value of [money(0, 'IDR'), money(2_893_400, 'IDR'), money(-26_783, 'USD')]) {
      const restored = fromJson(JSON.parse(JSON.stringify(toJson(value))))

      expect(restored).toEqual(value)
    }
  })

  test('nilai uang cacat dari sumber luar menghasilkan undefined, bukan lemparan', () => {
    // Uang cacat yang datang dari pesan atau respons supplier adalah data yang
    // salah, bukan kerusakan sistem.
    for (const bad of [
      null,
      undefined,
      {},
      { amountMinor: 1 },
      { currency: 'IDR' },
      { amountMinor: 1.5, currency: 'IDR' },
      { amountMinor: 1, currency: 'EUR' },
      { amountMinor: '1000', currency: 'IDR' },
    ]) {
      expect(fromJson(bad)).toBeUndefined()
    }
  })

  test('parseMoney melempar untuk data milik kita sendiri', () => {
    expect(() => parseMoney({ amountMinor: 1, currency: 'EUR' })).toThrow()
    expect(parseMoney({ amountMinor: 1_000, currency: 'IDR' }).amountMinor).toBe(1_000)
  })

  test('skema menolak pecahan', () => {
    // Pecahan yang lolos berarti seseorang menyimpan rupiah penuh di kolom
    // satuan terkecil, atau sebaliknya.
    expect(moneySchema.safeParse({ amountMinor: 26_783.5, currency: 'USD' }).success).toBe(false)
  })
})

describe('kolom basis data', () => {
  test('disimpan sebagai dua kolom: bilangan bulat dan kode mata uang', () => {
    // Tidak pernah satu kolom Float — NFR-08.
    expect(toColumns(money(2_893_400, 'IDR'), 'total')).toEqual({
      totalAmountMinor: 2_893_400,
      totalCurrency: 'IDR',
    })
  })

  test('dibaca kembali dari kedua kolom', () => {
    expect(fromColumns(2_893_400, 'IDR')).toEqual(money(2_893_400, 'IDR'))
  })

  test('kode mata uang yang tidak dikenal menghasilkan undefined', () => {
    expect(fromColumns(1_000, 'EUR')).toBeUndefined()
  })
})

describe('pemformatan', () => {
  test('rupiah ditampilkan tanpa desimal', () => {
    const formatted = format(money(2_893_400, 'IDR'))

    expect(formatted).toContain('2')
    expect(formatted).not.toContain(',00')
  })

  test('dolar ditampilkan dengan dua desimal', () => {
    expect(format(money(26_783, 'USD'), { locale: 'en-US' })).toBe('$267.83')
  })

  test('dapat menampilkan kode alih-alih simbol', () => {
    expect(format(money(26_783, 'USD'), { locale: 'en-US', display: 'code' })).toContain('USD')
  })

  test('dapat menampilkan angkanya saja', () => {
    expect(format(money(26_783, 'USD'), { locale: 'en-US', display: 'none' })).toBe('267.83')
  })

  test('bentuk desimal polos disusun dengan operasi string', () => {
    // Pembagian menghasilkan nilai seperti 267.82999999999998 pada sebagian
    // angka; penyusunan string tidak punya persoalan itu.
    expect(toDecimalString(money(26_783, 'USD'))).toBe('267.83')
    expect(toDecimalString(money(5, 'USD'))).toBe('0.05')
    expect(toDecimalString(money(-5, 'USD'))).toBe('-0.05')
    expect(toDecimalString(money(2_893_400, 'IDR'))).toBe('2893400')
  })
})
