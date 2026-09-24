import { describe, expect, test } from 'vitest'
import {
  calendarDateFromEpochSeconds,
  calendarDateFromInstant,
  calendarDateFromOrbit,
  epochSecondsFromCalendarDate,
  isCalendarDate,
  nightsBetween,
  toOrbitDate,
} from './dates.js'

/**
 * Tanggal.
 *
 * Seluruh pengujian di sini memakai tanggal di atas 12. Tanggal kecil tidak
 * membedakan DD/MM dari MM/DD, dan rangkaian uji yang seluruhnya memakai
 * tanggal kecil akan lulus dengan parser yang terbalik.
 */

describe('tanggal ORBIT', () => {
  test('membaca urutan hari-bulan, bukan bulan-hari', () => {
    // 10/11/2026 adalah 10 November, bukan 11 Oktober.
    expect(calendarDateFromOrbit('10/11/2026')).toBe('2026-11-10')
    expect(calendarDateFromOrbit('01/10/2026')).toBe('2026-10-01')
  })

  test('tanggal di atas 12 membuktikan urutannya', () => {
    // Parser yang mengasumsikan urutan Amerika akan gagal, bukan salah diam-diam.
    expect(calendarDateFromOrbit('25/12/2026')).toBe('2026-12-25')
    expect(calendarDateFromOrbit('31/01/2027')).toBe('2027-01-31')
  })

  test('menolak tanggal yang tidak ada', () => {
    // Penyusunan string saja akan meloloskan 31/02 dan menghasilkan 3 Maret.
    expect(calendarDateFromOrbit('31/02/2026')).toBeUndefined()
    expect(calendarDateFromOrbit('30/02/2026')).toBeUndefined()
    expect(calendarDateFromOrbit('32/01/2026')).toBeUndefined()
  })

  test('menolak bentuk yang bukan DD/MM/YYYY', () => {
    for (const value of ['2026-11-10', '1/11/2026', '10/11/26', '', 'kemarin']) {
      expect(calendarDateFromOrbit(value)).toBeUndefined()
    }
  })

  test('menulis kembali ke bentuk ORBIT', () => {
    expect(toOrbitDate('2026-11-10')).toBe('10/11/2026')
    expect(toOrbitDate('bukan tanggal')).toBeUndefined()
  })
})

describe('tanggal NOVA', () => {
  test('mengambil tanggal dalam UTC', () => {
    expect(calendarDateFromInstant('2026-11-10T00:00:00Z')).toBe('2026-11-10')
  })

  test('titik waktu berzona diurai, bukan dipotong', () => {
    // Memotong sepuluh karakter pertama menghasilkan 2026-11-10, padahal
    // tengah malam di Jakarta adalah 9 November pukul 17.00 UTC.
    expect(calendarDateFromInstant('2026-11-10T00:00:00+07:00')).toBe('2026-11-09')
    expect(calendarDateFromInstant('2026-11-10T23:00:00-05:00')).toBe('2026-11-11')
  })

  test('menolak yang bukan titik waktu', () => {
    expect(calendarDateFromInstant('bukan tanggal')).toBeUndefined()
  })
})

describe('tanggal LUNA', () => {
  test('epoch detik menjadi tanggal kalender dalam UTC', () => {
    expect(calendarDateFromEpochSeconds(1_794_268_800)).toBe('2026-11-10')
  })

  test('bolak-balik menghasilkan tanggal yang sama', () => {
    const epoch = epochSecondsFromCalendarDate('2026-11-10')
    expect(epoch).toBeDefined()
    expect(calendarDateFromEpochSeconds(epoch ?? 0)).toBe('2026-11-10')
  })

  test('menolak angka yang bukan waktu', () => {
    expect(calendarDateFromEpochSeconds(Number.NaN)).toBeUndefined()
    expect(calendarDateFromEpochSeconds(Number.POSITIVE_INFINITY)).toBeUndefined()
    expect(calendarDateFromEpochSeconds(1e15)).toBeUndefined()
  })

  test('menolak tanggal kalender yang tidak sah saat dikirim ke supplier', () => {
    expect(epochSecondsFromCalendarDate('10/11/2026')).toBeUndefined()
    expect(epochSecondsFromCalendarDate('')).toBeUndefined()
  })
})

describe('bentuk tanggal kalender', () => {
  test('mengenali YYYY-MM-DD', () => {
    expect(isCalendarDate('2026-11-10')).toBe(true)
    expect(isCalendarDate('2026-11-10T00:00:00Z')).toBe(false)
    expect(isCalendarDate('10/11/2026')).toBe(false)
  })

  test('menghitung banyak malam', () => {
    expect(nightsBetween('2026-11-10', '2026-11-12')).toBe(2)
    expect(nightsBetween('2026-11-10', '2026-11-10')).toBe(0)
    expect(nightsBetween('bukan', '2026-11-12')).toBeUndefined()
  })

  test('perhitungan malam benar melewati pergantian bulan', () => {
    expect(nightsBetween('2026-10-30', '2026-11-02')).toBe(3)
  })
})
