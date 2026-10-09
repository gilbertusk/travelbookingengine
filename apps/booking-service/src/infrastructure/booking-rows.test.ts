import { describe, expect, test } from 'vitest'
import { money } from '@tbe/money'
import {
  SAMPLE_TERMS,
  inState,
  minutesAfter,
  narrow,
  priceChanged,
  refunding,
  sampleQuote,
  step,
  validCommand,
} from '../testing/builders.js'
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

  test('peninjauan dari keadaan selain PAID, FAILED, atau CANCELLING ditolak', () => {
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

describe('ketentuan tawaran (Step 23)', () => {
  test('ketentuan tawaran selamat pulang-pergi lewat baris, di keadaan mana pun', () => {
    for (const status of ['DRAFT', 'HELD', 'CONFIRMED'] as const) {
      expect(fromRow(toRow(inState(status))).terms).toEqual(SAMPLE_TERMS)
    }
  })

  test('baris sebelum Step 23 dibaca tanpa ketentuan, bukan sebagai galat', () => {
    const legacy: BookingRow = { ...toRow(inState('CONFIRMED')), offerTerms: { terms: null } }

    const booking = fromRow(legacy)

    expect(booking.terms).toBeUndefined()
    expect('terms' in booking).toBe(false)
  })

  test('pemesanan tanpa ketentuan ditulis sebagai terms null', () => {
    const { terms, ...withoutTerms } = inState('DRAFT')

    expect(terms).toBeDefined()
    expect(toRow(withoutTerms).offerTerms).toEqual({ terms: null })
  })

  test.each([
    ['bukan bentuknya', { roomTypeName: 'Deluxe' }, 'offerTerms'],
    ['nama kamar kosong', { terms: { ...SAMPLE_TERMS, roomTypeName: '  ' } }, 'offerTerms.terms'],
  ])('ketentuan yang %s ditolak dengan nama kolomnya', (_name, offerTerms, column) => {
    const row: BookingRow = { ...toRow(inState('DRAFT')), offerTerms }

    expect(() => fromRow(row)).toThrow(CorruptBookingRowError)
    expect(() => fromRow(row)).toThrow(column)
  })
})

describe('pembatalan oleh pengguna (Step 25)', () => {
  function cancelledWithoutRefund() {
    const confirmed = inState('CONFIRMED')
    const at = minutesAfter(confirmed.updatedAt, 1)
    const cancelling = step(confirmed, {
      type: 'requestCancellation',
      at,
      quote: sampleQuote(money(0, 'IDR')),
      replyBy: minutesAfter(at, 10),
    })

    return step(cancelling, {
      type: 'completeCancellation',
      at: minutesAfter(at, 1),
      settlement: { kind: 'nothing_due' },
    })
  }

  function cancelledWithRefund() {
    const awaitingRefund = refunding()

    return step(awaitingRefund, validCommand(awaitingRefund, 'completeCancellation'))
  }

  function reviewedFromCancelling() {
    const awaitingRefund = refunding()

    return step(awaitingRefund, validCommand(awaitingRefund, 'requireReview'))
  }

  test.each([
    ['CANCELLING menunggu supplier', () => inState('CANCELLING')],
    ['CANCELLING menunggu refund', refunding],
    ['CANCELLED dengan refund', cancelledWithRefund],
    ['CANCELLED tanpa dana kembali', cancelledWithoutRefund],
    ['NEEDS_REVIEW dari CANCELLING', reviewedFromCancelling],
  ])('%s selamat pulang-pergi lewat baris', (_name, build) => {
    const booking = build()

    expect(fromRow(toRow(booking))).toEqual(booking)
  })

  test('jadwal pengembalian selamat pulang-pergi lewat baris', () => {
    const booking = inState('PRICE_CHECKED')

    expect(booking.refundSchedule).toBeDefined()
    expect(fromRow(toRow(booking)).refundSchedule).toEqual(booking.refundSchedule)
  })

  test('baris tanpa jadwal dibaca tanpa jadwal, bukan sebagai galat', () => {
    const legacy: BookingRow = { ...toRow(inState('CONFIRMED')), refundSchedule: { tiers: null } }

    expect('refundSchedule' in fromRow(legacy)).toBe(false)
  })

  test.each([
    ['bukan bentuknya', { jenjang: [] }],
    [
      'jenjang tidak terurut',
      {
        tiers: [
          { minHoursBefore: 24, percent: 50 },
          { minHoursBefore: 168, percent: 100 },
        ],
      },
    ],
  ])('jadwal yang %s ditolak', (_name, refundSchedule) => {
    const row: BookingRow = { ...toRow(inState('CONFIRMED')), refundSchedule }

    expect(() => fromRow(row)).toThrow('refundSchedule')
  })

  test('CANCELLING tanpa langkah yang ditunggu ditolak', () => {
    const row: BookingRow = { ...toRow(inState('CANCELLING')), cancelStep: null }

    expect(() => fromRow(row)).toThrow('cancelStep')
  })

  test('CANCELLED berbayar tanpa persetujuan pembatalan ditolak', () => {
    const row: BookingRow = { ...toRow(cancelledWithRefund()), cancelRefundMinor: null }

    expect(() => fromRow(row)).toThrow('cancelRefundMinor')
  })

  test('dana yang wajib kembali tanpa refund tercatat ditolak', () => {
    const row: BookingRow = { ...toRow(cancelledWithRefund()), refundId: null }

    expect(() => fromRow(row)).toThrow('refundId')
  })

  test('refund tercatat untuk pembatalan tanpa dana kembali ditolak', () => {
    const row: BookingRow = {
      ...toRow(cancelledWithoutRefund()),
      refundId: 'e1f2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a5b',
    }

    expect(() => fromRow(row)).toThrow('refundId')
  })

  test('pembatalan sebelum pembayaran tetap dibaca tanpa bidang pembayaran', () => {
    const booking = narrow(
      step(inState('HELD'), validCommand(inState('HELD'), 'cancel')),
      'CANCELLED',
    )

    expect(fromRow(toRow(booking))).toEqual(booking)
    expect(toRow(booking).cancelRefundMinor).toBeNull()
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
    ['larik berisi kekosongan', [1, undefined]],
  ])('bidang %s menggagalkan penulisan alih-alih menjadi null diam-diam', (_name, value) => {
    expect(() => toJsonObject({ amount: value })).toThrow('Bidang peristiwa amount')
  })

  test('larik jenjang pengembalian disimpan utuh (Step 25)', () => {
    const tiers = [
      { minHoursBefore: 72, percent: 100 },
      { minHoursBefore: 0, percent: 0 },
    ]

    expect(toJsonObject({ refundTiers: tiers })).toEqual({ refundTiers: tiers })
  })
})
