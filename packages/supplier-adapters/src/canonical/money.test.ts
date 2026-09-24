import { describe, expect, test } from 'vitest'
import { formatDecimalAmount, money, parseDecimalAmount } from './money.js'

/**
 * Uang.
 *
 * Bagian yang paling mudah terlihat benar dan paling mahal kalau salah.
 * Selisih satu sen per pemesanan tidak terlihat di layar mana pun, dan baru
 * muncul sebagai angka yang tidak cocok saat rekonsiliasi dengan supplier.
 */

describe('penguraian harga desimal', () => {
  test('mengubah USD menjadi sen', () => {
    expect(parseDecimalAmount('267.83', 'USD')).toBe(26783)
    expect(parseDecimalAmount('0.05', 'USD')).toBe(5)
    expect(parseDecimalAmount('1000.00', 'USD')).toBe(100_000)
  })

  test('menerima pemisah ribuan', () => {
    // Number('1,250.00') menghasilkan NaN. Supplier tetap mengirimkannya.
    expect(parseDecimalAmount('1,250.00', 'USD')).toBe(125_000)
    expect(parseDecimalAmount('12,345,678.90', 'USD')).toBe(1_234_567_890)
  })

  test('IDR tidak punya pecahan, jadi angkanya sudah satuan terkecil', () => {
    expect(parseDecimalAmount('2675400', 'IDR')).toBe(2_675_400)
    expect(parseDecimalAmount('2675400.00', 'IDR')).toBe(2_675_400)
  })

  test('tidak kehilangan sen karena pembulatan pecahan', () => {
    // Math.round(Number('8.115') * 100) menghasilkan 811 pada IEEE 754,
    // bukan 812 — perhitungan berbasis string tidak punya persoalan itu.
    expect(parseDecimalAmount('8.11', 'USD')).toBe(811)
    expect(parseDecimalAmount('1.005', 'USD')).toBeUndefined()
  })

  test('menolak desimal yang lebih rinci daripada satuan terkecilnya', () => {
    // Membulatkan diam-diam berarti menagih pengguna dengan angka yang tidak
    // pernah disebutkan supplier maupun ditampilkan kepadanya.
    expect(parseDecimalAmount('267.835', 'USD')).toBeUndefined()
    expect(parseDecimalAmount('2675400.5', 'IDR')).toBeUndefined()
  })

  test('nol di belakang koma tetap diterima', () => {
    expect(parseDecimalAmount('267.8300', 'USD')).toBe(26783)
    expect(parseDecimalAmount('2675400.000', 'IDR')).toBe(2_675_400)
  })

  test('menolak bentuk yang bukan angka alih-alih memaksanya', () => {
    for (const value of ['', 'abc', '12.', '.5', 'NaN', 'Infinity', '1,25.00', '1,2345.00']) {
      expect(parseDecimalAmount(value, 'USD')).toBeUndefined()
    }
  })

  test('menerima nilai negatif untuk pengembalian dana', () => {
    expect(parseDecimalAmount('-12.50', 'USD')).toBe(-1250)
  })
})

describe('penulisan kembali ke desimal', () => {
  test('bolak-balik menghasilkan nilai yang sama', () => {
    for (const value of ['0.05', '267.83', '1000.00']) {
      const minor = parseDecimalAmount(value, 'USD')
      expect(minor).toBeDefined()
      expect(formatDecimalAmount(money(minor ?? 0, 'USD'))).toBe(value)
    }
  })

  test('IDR ditulis tanpa pecahan', () => {
    expect(formatDecimalAmount(money(2_675_400, 'IDR'))).toBe('2675400')
  })

  test('nilai di bawah satu tetap punya angka nol di depan koma', () => {
    expect(formatDecimalAmount(money(5, 'USD'))).toBe('0.05')
    expect(formatDecimalAmount(money(-5, 'USD'))).toBe('-0.05')
  })
})
