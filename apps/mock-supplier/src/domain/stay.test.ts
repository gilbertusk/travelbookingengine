import { describe, expect, test } from 'vitest'
import { addDays, enumerateNights, isWeekendNight, nightsBetween, validateStay } from './stay.js'

describe('stay', () => {
  test('malam yang ditempati tidak termasuk tanggal keluar', () => {
    // Menghitung malam kepergian berarti mengurangi satu unit ketersediaan
    // yang sebenarnya masih bisa dijual ke tamu lain.
    expect(enumerateNights('2026-11-10', '2026-11-13')).toEqual([
      '2026-11-10',
      '2026-11-11',
      '2026-11-12',
    ])
  })

  test('menginap satu malam menghasilkan satu tanggal', () => {
    expect(enumerateNights('2026-11-10', '2026-11-11')).toEqual(['2026-11-10'])
  })

  test('rentang tidak sah menghasilkan daftar kosong', () => {
    expect(enumerateNights('2026-11-12', '2026-11-10')).toEqual([])
  })

  test('penambahan hari melewati batas bulan dengan benar', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01')
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
  })

  test('jumlah malam dihitung lintas bulan', () => {
    expect(nightsBetween('2026-01-30', '2026-02-02')).toBe(3)
  })

  test('menolak tanggal yang tidak berformat YYYY-MM-DD', () => {
    expect(validateStay('10/11/2026', '2026-11-12')).toBe('invalid_date')
    expect(validateStay('2026-11-10', '12 Nov 2026')).toBe('invalid_date')
  })

  test('menolak tanggal keluar yang tidak setelah tanggal masuk', () => {
    expect(validateStay('2026-11-12', '2026-11-12')).toBe('not_positive')
    expect(validateStay('2026-11-12', '2026-11-10')).toBe('not_positive')
  })

  test('menolak menginap yang terlalu panjang', () => {
    expect(validateStay('2026-11-10', '2026-12-20')).toBe('too_long')
  })

  test('menerima rentang yang wajar', () => {
    expect(validateStay('2026-11-10', '2026-11-12')).toBeUndefined()
  })

  test('mengenali malam akhir pekan', () => {
    // 2026-11-13 adalah Jumat, 2026-11-14 Sabtu, 2026-11-15 Minggu
    expect(isWeekendNight('2026-11-13')).toBe(true)
    expect(isWeekendNight('2026-11-14')).toBe(true)
    expect(isWeekendNight('2026-11-15')).toBe(false)
  })
})
