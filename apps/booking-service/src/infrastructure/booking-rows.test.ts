import { describe, expect, test } from 'vitest'
import { inState, priceChanged } from '../testing/builders.js'
import type { BookingRow } from './booking-db.js'
import { CorruptBookingRowError } from './booking-row-reader.js'
import { fromDateColumn, fromRow, toDateColumn, toJsonObject, toRow } from './booking-rows.js'
import { parseLocalDate, type LocalDate } from '../domain/stay-dates.js'

function localDate(value: string): LocalDate {
  const parsed = parseLocalDate(value)
  if (parsed === undefined) throw new Error(`bukan tanggal: ${value}`)

  return parsed
}

describe('kolom DATE (NFR-09)', () => {
  /**
   * Penjaga penjaga. Uji di bawah hanya bermakna bila proses uji TIDAK
   * berjalan di UTC — vitest.config.ts menetapkan America/Los_Angeles. Kalau
   * penetapan itu hilang, uji berikutnya tetap hijau untuk kode yang salah;
   * uji ini yang gagal lebih dulu.
   */
  test('proses uji berjalan di zona yang bukan UTC', () => {
    expect(new Date('2026-11-10T00:00:00Z').getTimezoneOffset()).not.toBe(0)
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('America/Los_Angeles')
  })

  test('tanggal ditulis sebagai tengah malam UTC tanggal yang sama', () => {
    expect(toDateColumn(localDate('2026-11-10')).toISOString()).toBe('2026-11-10T00:00:00.000Z')
  })

  test('tengah malam UTC dibaca kembali sebagai tanggal yang sama, bukan hari sebelumnya', () => {
    // Di Los Angeles, getDate() atas nilai ini adalah 9.
    expect(fromDateColumn(new Date('2026-11-10T00:00:00.000Z'))).toBe('2026-11-10')
  })

  test.each(['2026-01-01', '2026-03-08', '2026-11-01', '2026-12-31', '2028-02-29'])(
    '%s bertahan pulang-pergi melewati kolom DATE',
    (value) => {
      expect(fromDateColumn(toDateColumn(localDate(value)))).toBe(value)
    },
  )

  test('baris pemesanan menyimpan tanggal menginap tanpa pergeseran', () => {
    const row = toRow(inState('DRAFT'))

    expect(row.checkIn.toISOString()).toBe('2026-11-10T00:00:00.000Z')
    expect(row.checkOut.toISOString()).toBe('2026-11-12T00:00:00.000Z')
  })
})

describe('baris dibaca dengan tidak mempercayai basis data', () => {
  function rowOf(status: Parameters<typeof inState>[0]): BookingRow {
    return toRow(inState(status))
  }

  function expectCorrupt(row: BookingRow, column: string): void {
    expect(() => fromRow(row)).toThrow(CorruptBookingRowError)
    expect(() => fromRow(row)).toThrow(column)
  }

  test('CONFIRMED tanpa booking reference ditolak dengan nama kolomnya', () => {
    expectCorrupt({ ...rowOf('CONFIRMED'), supplierRef: null }, 'supplierRef')
  })

  test('HELD tanpa batas waktu hold ditolak', () => {
    expectCorrupt({ ...rowOf('HELD'), heldUntil: null }, 'heldUntil')
  })

  test('kode supplier yang tidak dikenal ditolak', () => {
    expectCorrupt({ ...rowOf('DRAFT'), supplierId: 'ACME' }, 'supplierId')
  })

  test('check-out sebelum check-in ditolak', () => {
    const row = rowOf('DRAFT')

    expectCorrupt({ ...row, checkOut: row.checkIn }, 'checkIn/checkOut')
  })

  test('tanggal di luar tahun empat digit ditolak', () => {
    expectCorrupt(
      { ...rowOf('DRAFT'), checkOut: new Date('+010000-01-01T00:00:00.000Z') },
      'checkOut',
    )
  })

  test('surel tamu yang rusak ditolak', () => {
    expectCorrupt({ ...rowOf('DRAFT'), leadGuestEmail: 'bukan-surel' }, 'guests')
  })

  test('kunci idempotensi yang rusak ditolak', () => {
    expectCorrupt({ ...rowOf('DRAFT'), idempotencyKey: 'x' }, 'idempotencyKey')
  })

  test('rincian harga yang bukan bentuknya ditolak', () => {
    expectCorrupt({ ...rowOf('DRAFT'), priceLines: { agreed: 'rusak' } }, 'priceLines')
  })

  test('total kolom yang berbeda dari jumlah rinciannya ditolak', () => {
    expectCorrupt({ ...rowOf('DRAFT'), amountMinor: 1 }, 'priceLines.agreed')
  })

  test('mata uang kolom yang tidak dikenal ditolak', () => {
    expectCorrupt({ ...rowOf('DRAFT'), currency: 'XYZ' }, 'amountMinor/currency')
  })

  test('rincian tanpa malam kamar ditolak', () => {
    expectCorrupt(
      { ...rowOf('DRAFT'), priceLines: { agreed: [], quoted: null } },
      'priceLines.agreed',
    )
  })

  test('harga yang menunggu persetujuan tanpa rinciannya ditolak', () => {
    // Rincian harga yang DISETUJUI dibiarkan utuh. Versi pertama uji ini
    // mengosongkan keduanya, dan penolakannya terjadi pada `agreed` — uji
    // lulus tanpa pernah menyentuh jalur yang disebut namanya. Cakupan cabang
    // yang menemukannya.
    const row = toRow(priceChanged())
    const lines = { ...row.priceLines, quoted: null }

    expectCorrupt({ ...row, priceLines: lines }, 'priceLines.quoted')
  })

  test('harga yang menunggu persetujuan tanpa totalnya ditolak', () => {
    expectCorrupt({ ...toRow(priceChanged()), quotedAmountMinor: null }, 'quotedAmountMinor')
  })

  test('peninjauan dari keadaan selain PAID atau FAILED ditolak', () => {
    expectCorrupt({ ...rowOf('NEEDS_REVIEW'), reviewFrom: 'HELD' }, 'reviewFrom')
  })

  test('galat baris rusak menyebut pemesanan dan kolomnya', () => {
    const row = { ...rowOf('PAID'), paymentId: null }

    try {
      fromRow(row)
      expect.unreachable('baris rusak seharusnya ditolak')
    } catch (error) {
      expect(error).toMatchObject({ bookingId: row.id, column: 'paymentId' })
    }
  })
})

describe('isi peristiwa sebagai JSON', () => {
  test('tanggal menjadi ISO dan uang tetap bilangan bulat bermata uang', () => {
    expect(
      toJsonObject({
        at: new Date('2026-10-01T03:00:00.000Z'),
        amount: { amountMinor: 5, currency: 'IDR' },
        flag: true,
      }),
    ).toEqual({
      at: '2026-10-01T03:00:00.000Z',
      amount: { amountMinor: 5, currency: 'IDR' },
      flag: true,
    })
  })

  test.each([
    ['kosong', undefined],
    ['bigint', 10n],
    ['larik', [1, 2]],
  ])('bidang %s menggagalkan penulisan alih-alih menjadi null diam-diam', (_name, value) => {
    expect(() => toJsonObject({ amount: value })).toThrow('Bidang peristiwa amount')
  })
})
