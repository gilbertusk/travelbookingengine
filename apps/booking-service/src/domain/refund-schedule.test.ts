import { money } from '@tbe/money'
import { describe, expect, test } from 'vitest'
import {
  DEFAULT_REFUND_TIERS,
  quoteRefund,
  refundSchedule,
  scheduleFor,
  type RefundSchedule,
  type RefundTier,
} from './refund-schedule.js'
import { parseLocalDate, type LocalDate } from './stay-dates.js'

const HOUR = 3_600_000

function date(value: string): LocalDate {
  const parsed = parseLocalDate(value)
  if (parsed === undefined) throw new Error(`bukan tanggal: ${value}`)

  return parsed
}

function schedule(tiers: readonly RefundTier[]): RefundSchedule {
  const built = refundSchedule(tiers)
  if (!built.ok) throw new Error(`jadwal tidak sah: ${built.error.kind}`)

  return built.value
}

const Q3 = schedule(DEFAULT_REFUND_TIERS)
const CHECK_IN = date('2026-11-10')
/** Tengah malam 10 November di Jakarta (UTC+7). */
const JAKARTA_START = Date.parse('2026-11-09T17:00:00Z')
const PAID = money(1_000_001, 'IDR')

function hoursBefore(hours: number, start = JAKARTA_START): Date {
  return new Date(start - hours * HOUR)
}

function quoteAt(at: Date, timeZone = 'Asia/Jakarta', tiers = Q3) {
  return quoteRefund({ schedule: tiers, checkIn: CHECK_IN, timeZone, paid: PAID, at })
}

describe('jadwal pengembalian dari kebijakan supplier', () => {
  test('rate non-refundable tidak mengembalikan apa pun, kapan pun', () => {
    expect(scheduleFor({ refundable: false }).tiers).toEqual([{ minHoursBefore: 0, percent: 0 }])
  })

  test('rate refundable tanpa tenggat dari supplier memakai jenjang Q3 apa adanya', () => {
    expect(scheduleFor({ refundable: true }).tiers).toEqual([
      { minHoursBefore: 168, percent: 100 },
      { minHoursBefore: 24, percent: 50 },
      { minHoursBefore: 0, percent: 0 },
    ])
  })

  test('tenggat pembatalan gratis dari supplier menggantikan tujuh hari', () => {
    expect(scheduleFor({ refundable: true, freeCancellationDays: 3 }).tiers).toEqual([
      { minHoursBefore: 72, percent: 100 },
      { minHoursBefore: 24, percent: 50 },
      { minHoursBefore: 0, percent: 0 },
    ])
  })

  test('tenggat gratis satu hari meniadakan jenjang 50%', () => {
    expect(scheduleFor({ refundable: true, freeCancellationDays: 1 }).tiers).toEqual([
      { minHoursBefore: 24, percent: 100 },
      { minHoursBefore: 0, percent: 0 },
    ])
  })

  test('tenggat gratis nol hari berarti gratis sampai tanggal masuk', () => {
    expect(scheduleFor({ refundable: true, freeCancellationDays: 0 }).tiers).toEqual([
      { minHoursBefore: 0, percent: 100 },
    ])
  })
})

describe('validasi jadwal', () => {
  test('jadwal kosong ditolak', () => {
    expect(refundSchedule([])).toEqual({ ok: false, error: { kind: 'empty' } })
  })

  test('jenjang yang tidak terurut ditolak, bukan diurutkan diam-diam', () => {
    const result = refundSchedule([
      { minHoursBefore: 24, percent: 50 },
      { minHoursBefore: 168, percent: 100 },
      { minHoursBefore: 0, percent: 0 },
    ])

    expect(result).toEqual({ ok: false, error: { kind: 'not_ordered' } })
  })

  test('jenjang yang tumpang tindih ditolak', () => {
    const result = refundSchedule([
      { minHoursBefore: 24, percent: 100 },
      { minHoursBefore: 24, percent: 50 },
      { minHoursBefore: 0, percent: 0 },
    ])

    expect(result).toEqual({ ok: false, error: { kind: 'overlapping' } })
  })

  test('jadwal yang tidak menjangkau sampai tanggal masuk ditolak', () => {
    const result = refundSchedule([
      { minHoursBefore: 168, percent: 100 },
      { minHoursBefore: 24, percent: 50 },
    ])

    expect(result).toEqual({ ok: false, error: { kind: 'gap_before_check_in' } })
  })

  test.each([[-1], [101], [12.5], [Number.NaN]])('persentase %s ditolak', (percent) => {
    const result = refundSchedule([{ minHoursBefore: 0, percent }])

    expect(result).toEqual({ ok: false, error: { kind: 'invalid_percent' } })
  })

  test.each([[-24], [1.5], [Number.POSITIVE_INFINITY]])('batas jam %s ditolak', (hours) => {
    const result = refundSchedule([
      { minHoursBefore: hours, percent: 100 },
      { minHoursBefore: 0, percent: 0 },
    ])

    expect(result).toEqual({ ok: false, error: { kind: 'invalid_hours' } })
  })

  test('pengembalian yang membesar mendekati tanggal masuk ditolak', () => {
    const result = refundSchedule([
      { minHoursBefore: 168, percent: 50 },
      { minHoursBefore: 0, percent: 100 },
    ])

    expect(result).toEqual({ ok: false, error: { kind: 'refund_increases' } })
  })
})

describe('perhitungan pengembalian per jenjang', () => {
  test('lebih dari tujuh hari sebelumnya: seluruh pembayaran kembali', () => {
    const quote = quoteAt(hoursBefore(200))

    expect(quote.ok && quote.value).toMatchObject({ percent: 100, refund: PAID })
  })

  test('tepat tujuh hari sebelumnya masih jenjang 100%', () => {
    const quote = quoteAt(hoursBefore(168))

    expect(quote.ok && quote.value.percent).toBe(100)
  })

  test('satu milidetik lewat dari tujuh hari: jenjang 50%, sisa pembagian ke pengguna', () => {
    const quote = quoteAt(new Date(JAKARTA_START - 168 * HOUR + 1))

    // 1.000.001 dibagi dua tanpa kehilangan satu rupiah pun: 500.001 kembali,
    // 500.000 tertahan sesuai kebijakan.
    expect(quote.ok && quote.value).toMatchObject({
      percent: 50,
      refund: money(500_001, 'IDR'),
    })
  })

  test('tepat 24 jam sebelumnya masih jenjang 50%', () => {
    const quote = quoteAt(hoursBefore(24))

    expect(quote.ok && quote.value.percent).toBe(50)
  })

  test('kurang dari 24 jam: tidak ada pengembalian, dengan penjelasan jenjangnya', () => {
    const quote = quoteAt(hoursBefore(2))

    expect(quote.ok && quote.value).toMatchObject({
      percent: 0,
      refund: money(0, 'IDR'),
      until: new Date(JAKARTA_START),
      next: undefined,
    })
  })

  test('menyebut sampai kapan jenjang ini berlaku dan berapa jenjang sesudahnya', () => {
    const quote = quoteAt(hoursBefore(200))

    expect(quote.ok && quote.value).toMatchObject({
      until: new Date(JAKARTA_START - 168 * HOUR),
      next: { percent: 50 },
    })
  })

  test('jadwal lengkap dinyatakan sebagai titik waktu konkret', () => {
    const quote = quoteAt(hoursBefore(200))

    expect(quote.ok && quote.value.tiers).toEqual([
      { percent: 100, until: new Date(JAKARTA_START - 168 * HOUR) },
      { percent: 50, until: new Date(JAKARTA_START - 24 * HOUR) },
      { percent: 0, until: new Date(JAKARTA_START) },
    ])
  })

  test('pengembalian nol setelah tenggat menyebut tenggat terakhir yang terlewat', () => {
    const quote = quoteAt(hoursBefore(2))

    expect(quote.ok && quote.value.nothingBack).toEqual({
      kind: 'past_deadline',
      lastRefund: { percent: 50, until: new Date(JAKARTA_START - 24 * HOUR) },
    })
  })

  test('rate non-refundable dijelaskan sebagai non-refundable, bukan tenggat yang lewat', () => {
    const quote = quoteAt(hoursBefore(400), 'Asia/Jakarta', scheduleFor({ refundable: false }))

    expect(quote.ok && quote.value).toMatchObject({
      percent: 0,
      refund: money(0, 'IDR'),
      nothingBack: { kind: 'non_refundable' },
    })
  })

  test('pengembalian yang masih ada tidak membawa penjelasan kosong', () => {
    const quote = quoteAt(hoursBefore(200))

    expect(quote.ok && quote.value.nothingBack).toBeUndefined()
  })

  test('menginap yang sudah dimulai tidak dapat dibatalkan', () => {
    expect(quoteAt(new Date(JAKARTA_START))).toEqual({ ok: false, error: { kind: 'stay_started' } })
  })

  test('mata uang selain rupiah dibagi dalam sennya', () => {
    const quote = quoteRefund({
      schedule: Q3,
      checkIn: CHECK_IN,
      timeZone: 'Asia/Jakarta',
      paid: money(10_001, 'USD'),
      at: hoursBefore(48),
    })

    expect(quote.ok && quote.value.refund).toEqual(money(5_001, 'USD'))
  })

  test('zona waktu yang tidak dikenal ditolak, bukan ditebak', () => {
    expect(quoteAt(hoursBefore(200), 'Asia/Atlantis')).toEqual({
      ok: false,
      error: { kind: 'unknown_time_zone' },
    })
  })
})

describe('tenggat dihitung dengan zona waktu properti', () => {
  test('pemesan di Jakarta pukul 23.00 sudah lewat tenggat 24 jam di Tokyo', () => {
    // Pukul 23.00 WIB tanggal 8 November = 16.00 UTC = 01.00 tanggal 9 di
    // Tokyo. Tenggat 24 jam untuk check-in 10 November di Tokyo adalah tengah
    // malam tanggal 9 waktu Tokyo — sudah lewat satu jam.
    const at = new Date('2026-11-08T16:00:00Z')

    const tokyo = quoteAt(at, 'Asia/Tokyo')
    const jakarta = quoteAt(at, 'Asia/Jakarta')

    expect(tokyo.ok && tokyo.value.percent).toBe(0)
    // Dengan jam Jakarta, pembatalan yang sama keliru masuk jenjang 50%.
    expect(jakarta.ok && jakarta.value.percent).toBe(50)
  })

  test('properti di barat UTC punya tenggat yang lebih lambat dari UTC', () => {
    // Tengah malam 10 November di Los Angeles = 08.00 UTC tanggal 10.
    const at = new Date('2026-11-09T07:00:00Z')

    const quote = quoteAt(at, 'America/Los_Angeles')

    expect(quote.ok && quote.value.percent).toBe(50)
    expect(quote.ok && quote.value.checkInStartsAt).toEqual(new Date('2026-11-10T08:00:00Z'))
  })
})
