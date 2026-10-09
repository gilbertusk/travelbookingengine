import { describe, expect, test } from 'vitest'
import { startOfLocalDate } from './property-time.js'
import { parseLocalDate, type LocalDate } from './stay-dates.js'

function date(value: string): LocalDate {
  const parsed = parseLocalDate(value)
  if (parsed === undefined) throw new Error(`bukan tanggal: ${value}`)

  return parsed
}

function startOf(value: string, timeZone: string): string | undefined {
  return startOfLocalDate(date(value), timeZone)?.toISOString()
}

describe('awal tanggal lokal di zona waktu properti', () => {
  test('tengah malam di Tokyo adalah pukul 15.00 UTC hari sebelumnya', () => {
    expect(startOf('2026-11-10', 'Asia/Tokyo')).toBe('2026-11-09T15:00:00.000Z')
  })

  test('tengah malam di Jakarta adalah pukul 17.00 UTC hari sebelumnya', () => {
    expect(startOf('2026-11-10', 'Asia/Jakarta')).toBe('2026-11-09T17:00:00.000Z')
  })

  test('tengah malam di Bali berbeda satu jam dari Jakarta', () => {
    expect(startOf('2026-11-10', 'Asia/Makassar')).toBe('2026-11-09T16:00:00.000Z')
  })

  test('zona di barat UTC jatuh pada hari yang sama di UTC', () => {
    expect(startOf('2026-07-15', 'America/Los_Angeles')).toBe('2026-07-15T07:00:00.000Z')
  })

  test('hari pergantian jam musim dingin memakai selisih yang berlaku pada tengah malamnya', () => {
    // New York kembali ke EST pukul 02.00 tanggal 1 November 2026. Tengah
    // malamnya masih EDT (UTC-4).
    expect(startOf('2026-11-01', 'America/New_York')).toBe('2026-11-01T04:00:00.000Z')
    expect(startOf('2026-11-02', 'America/New_York')).toBe('2026-11-02T05:00:00.000Z')
  })

  test('hari pergantian jam musim panas memakai selisih yang berlaku pada tengah malamnya', () => {
    // New York maju ke EDT pukul 02.00 tanggal 8 Maret 2026. Tengah malamnya
    // masih EST (UTC-5).
    expect(startOf('2026-03-08', 'America/New_York')).toBe('2026-03-08T05:00:00.000Z')
  })

  test('tengah malam yang tidak ada: hari dimulai pada saat pergantian jam', () => {
    // Santiago maju dari 24.00 ke 01.00 pada 6 September 2026. Pukul 00.00
    // tanggal itu tidak pernah terjadi; detik pertamanya pukul 01.00 (UTC-3).
    expect(startOf('2026-09-06', 'America/Santiago')).toBe('2026-09-06T04:00:00.000Z')
  })

  test('tanggal yang dilompati zonanya tidak punya awal hari', () => {
    // Samoa pindah melintasi garis tanggal: 29 Desember 2011 langsung
    // disusul 31 Desember.
    expect(startOf('2011-12-30', 'Pacific/Apia')).toBeUndefined()
    expect(startOf('2011-12-31', 'Pacific/Apia')).toBe('2011-12-30T10:00:00.000Z')
  })

  test('zona waktu yang tidak dikenal tidak ditebak', () => {
    expect(startOf('2026-11-10', 'Asia/Atlantis')).toBeUndefined()
    expect(startOf('2026-11-10', '')).toBeUndefined()
  })

  test('hasilnya tidak bergantung pada zona waktu mesin', () => {
    // vitest.config.ts menjalankan uji di America/Los_Angeles. Jawaban yang
    // memakai jam lokal mesin akan meleset delapan jam di sini.
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).not.toBe('Asia/Tokyo')
    expect(startOf('2026-11-10', 'Asia/Tokyo')).toBe('2026-11-09T15:00:00.000Z')
  })
})
