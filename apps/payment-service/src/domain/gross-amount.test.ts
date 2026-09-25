import { money } from '@tbe/money'
import { describe, expect, test } from 'vitest'
import { parseGrossAmount } from './gross-amount.js'

describe('rupiah, eksponen 0', () => {
  test.each([
    ['1250000.00', 1_250_000],
    ['1250000', 1_250_000],
    ['0', 0],
    ['0.00', 0],
    ['1', 1],
  ])('"%s" menjadi %i rupiah', (raw, expected) => {
    expect(parseGrossAmount(raw, 'IDR')).toEqual(money(expected, 'IDR'))
  })

  /**
   * Satuan terkecil rupiah adalah rupiah itu sendiri — lihat alasan eksponen 0
   * pada @tbe/money. Setengah rupiah bukan nilai yang dapat disimpan, dan
   * membulatkannya diam-diam berarti menagih nilai yang berbeda dari yang
   * dikirim penyedia.
   */
  test('"1250000.50" ditolak karena rupiah tidak punya sen', () => {
    expect(parseGrossAmount('1250000.50', 'IDR')).toBeUndefined()
  })

  test('"1250000.001" ditolak', () => {
    expect(parseGrossAmount('1250000.001', 'IDR')).toBeUndefined()
  })
})

describe('dolar, eksponen 2', () => {
  test.each([
    ['10.50', 1_050],
    ['10', 1_000],
    ['10.5', 1_050],
    ['10.00', 1_000],
    ['0.01', 1],
    // Nilai ini yang menangkap perhitungan pecahan biner: Number('10.23') * 100
    // menghasilkan 1022.9999999999999, bukan 1023.
    ['10.23', 1_023],
    ['0.07', 7],
  ])('"%s" menjadi %i sen', (raw, expected) => {
    expect(parseGrossAmount(raw, 'USD')).toEqual(money(expected, 'USD'))
  })

  test('"10.005" ditolak karena sen tidak dapat dibagi lagi', () => {
    expect(parseGrossAmount('10.005', 'USD')).toBeUndefined()
  })

  test('"10.500" diterima karena digit ketiganya nol', () => {
    expect(parseGrossAmount('10.500', 'USD')).toEqual(money(1_050, 'USD'))
  })
})

/**
 * Setiap bentuk di bawah ini DITERIMA oleh `Number` atau `parseFloat`, dan
 * sebagian dengan nilai yang sama sekali berbeda dari yang terlihat. Inilah
 * sebabnya penguraiannya tidak boleh menyerahkan validasi kepada keduanya.
 */
describe('bentuk yang ditolak', () => {
  test.each([
    ['1e5', 'notasi ilmiah; Number membacanya sebagai 100000'],
    ['0x10', 'heksadesimal; Number membacanya sebagai 16'],
    [' 100 ', 'berspasi; Number memangkas spasi lalu menerimanya'],
    ['100abc', 'berakhiran huruf; parseFloat menerima awalannya'],
    ['', 'kosong; Number membacanya sebagai 0'],
    ['-100', 'negatif; penyedia tidak pernah menagih nilai negatif'],
    ['+100', 'bertanda'],
    ['1,250,000.00', 'berkoma sebagai pemisah ribuan'],
    ['1.250.000', 'dua titik desimal'],
    ['.50', 'tanpa bagian bulat'],
    ['100.', 'titik tanpa pecahan'],
    ['Infinity', 'Number membacanya sebagai bilangan'],
    ['NaN', 'Number membacanya sebagai NaN, bukan galat'],
  ])('"%s" ditolak — %s', (raw) => {
    expect(parseGrossAmount(raw, 'IDR')).toBeUndefined()
  })

  test('nilai di luar bilangan bulat aman ditolak', () => {
    // 16 digit bagian bulat melewati batas digit; 15 digit yang dikali 100
    // untuk USD melewati Number.MAX_SAFE_INTEGER dan tertangkap pemeriksaan
    // akhir. Keduanya diuji karena keduanya dijaga mekanisme yang berbeda.
    expect(parseGrossAmount('1234567890123456', 'IDR')).toBeUndefined()
    expect(parseGrossAmount('123456789012345', 'USD')).toBeUndefined()
  })
})

describe('kesetaraan dengan bahan tanda tangan', () => {
  /**
   * Tanda tangan dihitung atas string MENTAH, sementara perbandingan nilai
   * memakai hasil penguraian. Keduanya harus berbicara tentang nilai yang sama,
   * dan uji ini yang menjaga bahwa penguraian tidak mengubah artinya.
   */
  test('"1250000.00" dan "1250000" menghasilkan nilai yang sama meski tanda tangannya berbeda', () => {
    expect(parseGrossAmount('1250000.00', 'IDR')).toEqual(parseGrossAmount('1250000', 'IDR'))
  })
})
